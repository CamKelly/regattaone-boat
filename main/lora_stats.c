#include "lora_stats.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_SX1262_ENABLE

#include "ble_sen0140.h"
#include "lora_mesh.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define LORA_STATS_SIG_MAX 24

typedef struct {
    bool used;
    char sig[LORA_STATS_SIG_MAX];
    uint32_t first_seq;
    uint32_t last_seq;
    uint32_t high_seq;
    uint32_t missing;
    uint32_t rx_count;
    uint32_t last_arrival_seq;
    bool has_arrival;
} lora_stats_sender_t;

static SemaphoreHandle_t s_mtx;
static bool s_stream_active;
static uint32_t s_tx_queued;
static uint32_t s_tx_ok;
static uint32_t s_tx_timeout;
static uint32_t s_rx_bad;
static lora_stats_sender_t s_senders[LORA_STATS_MAX_SENDERS];
static char s_json_buf[8192];

static void stats_lock(void)
{
    if (s_mtx == NULL) {
        s_mtx = xSemaphoreCreateMutex();
    }
    if (s_mtx != NULL) {
        xSemaphoreTake(s_mtx, portMAX_DELAY);
    }
}

static void stats_unlock(void)
{
    if (s_mtx != NULL) {
        xSemaphoreGive(s_mtx);
    }
}

static void stats_notify(void)
{
    const size_t n = lora_stats_format_json(s_json_buf, sizeof(s_json_buf));
    if (n > 0) {
        ble_sen0140_lora_stats_notify((const uint8_t *)s_json_buf, n);
    }
}

static void trim_sig(const char *in, size_t in_len, char *out, size_t out_cap)
{
    size_t start = 0;
    while (start < in_len && (in[start] == ' ' || in[start] == '\t')) {
        start++;
    }
    size_t end = in_len;
    while (end > start && (in[end - 1] == ' ' || in[end - 1] == '\t')) {
        end--;
    }
    size_t n = end - start;
    if (n >= out_cap) {
        n = out_cap - 1;
    }
    memcpy(out, in + start, n);
    out[n] = '\0';
}

static bool parse_payload(const char *payload, size_t len, char *sig_out, uint32_t *seq_out)
{
    if (payload == NULL || len == 0 || sig_out == NULL || seq_out == NULL) {
        return false;
    }
    const char *hash = NULL;
    for (size_t i = len; i > 0; i--) {
        if (payload[i - 1] == '#') {
            hash = payload + (i - 1);
            break;
        }
    }
    if (hash == NULL || hash + 1 >= payload + len) {
        return false;
    }
    const char *num = hash + 1;
    size_t num_len = (size_t)((payload + len) - num);
    while (num_len > 0 && (num[num_len - 1] == ' ' || num[num_len - 1] == '\r' || num[num_len - 1] == '\n')) {
        num_len--;
    }
    if (num_len == 0) {
        return false;
    }
    uint32_t seq = 0;
    for (size_t i = 0; i < num_len; i++) {
        if (num[i] < '0' || num[i] > '9') {
            return false;
        }
        seq = seq * 10U + (uint32_t)(num[i] - '0');
    }
    trim_sig(payload, (size_t)(hash - payload), sig_out, LORA_STATS_SIG_MAX);
    if (sig_out[0] == '\0') {
        return false;
    }
    *seq_out = seq;
    return true;
}

static lora_stats_sender_t *sender_find(const char *sig)
{
    for (int i = 0; i < LORA_STATS_MAX_SENDERS; i++) {
        if (s_senders[i].used && strcmp(s_senders[i].sig, sig) == 0) {
            return &s_senders[i];
        }
    }
    return NULL;
}

static lora_stats_sender_t *sender_alloc(const char *sig)
{
    lora_stats_sender_t *slot = sender_find(sig);
    if (slot != NULL) {
        return slot;
    }
    for (int i = 0; i < LORA_STATS_MAX_SENDERS; i++) {
        if (!s_senders[i].used) {
            slot = &s_senders[i];
            slot->used = true;
            strncpy(slot->sig, sig, LORA_STATS_SIG_MAX - 1);
            slot->sig[LORA_STATS_SIG_MAX - 1] = '\0';
            return slot;
        }
    }
    return NULL;
}

static void sender_on_seq(lora_stats_sender_t *s, uint32_t seq)
{
    if (s->has_arrival && seq == s->last_arrival_seq) {
        return;
    }

    if (s->has_arrival && seq < s->high_seq) {
        const bool restart = seq <= s->first_seq && seq < s->last_arrival_seq;
        const bool gap_fill = s->missing > 0 && seq >= s->high_seq - s->missing;
        if (!restart && !gap_fill) {
            return;
        }
    }

    if (!s->has_arrival) {
        s->first_seq = seq;
        s->last_seq = seq;
        s->high_seq = seq;
        s->last_arrival_seq = seq;
        s->has_arrival = true;
        s->rx_count = 1;
        return;
    }

    s->rx_count++;
    s->last_seq = seq;
    s->last_arrival_seq = seq;

    if (seq > s->high_seq) {
        s->missing += seq - s->high_seq - 1U;
        s->high_seq = seq;
    } else if (seq < s->high_seq) {
        if (s->missing > 0 && seq >= s->high_seq - s->missing) {
            s->missing--;
        } else {
            s->high_seq = seq;
        }
    }
}

void lora_stats_set_stream_active(bool active)
{
    if (active && lora_mesh_active()) {
        return;
    }
    stats_lock();
    s_stream_active = active;
    stats_unlock();
    if (active) {
        stats_notify();
    }
}

void lora_stats_request_notify(void)
{
    stats_notify();
}

void lora_stats_mesh_tx_ok(void)
{
    stats_notify();
}

void lora_stats_mesh_tx_fail(void)
{
    stats_notify();
}

void lora_stats_mesh_rx_heartbeat(void)
{
    stats_notify();
}

bool lora_stats_stream_active(void)
{
    bool active;
    stats_lock();
    active = s_stream_active;
    stats_unlock();
    return active;
}

void lora_stats_tx_stream_queued(void)
{
    stats_lock();
    s_tx_queued++;
    stats_unlock();
    stats_notify();
}

void lora_stats_tx_stream_ok(void)
{
    stats_lock();
    s_tx_ok++;
    stats_unlock();
    stats_notify();
}

void lora_stats_tx_stream_timeout(void)
{
    stats_lock();
    s_tx_timeout++;
    stats_unlock();
    stats_notify();
}

void lora_stats_rx_bad(void)
{
    stats_lock();
    s_rx_bad++;
    stats_unlock();
    stats_notify();
}

void lora_stats_rx_packet(const char *payload, size_t len)
{
    char sig[LORA_STATS_SIG_MAX];
    uint32_t seq = 0;
    if (!parse_payload(payload, len, sig, &seq)) {
        return;
    }

    stats_lock();
    lora_stats_sender_t *s = sender_alloc(sig);
    if (s != NULL) {
        sender_on_seq(s, seq);
    }
    stats_unlock();
    stats_notify();
}

size_t lora_stats_format_json(char *out, size_t out_cap)
{
    if (out == NULL || out_cap == 0) {
        return 0;
    }

    stats_lock();
    int n = snprintf(out, out_cap,
                     "{\"tx\":{\"queued\":%lu,\"ok\":%lu,\"timeout\":%lu},\"rx_bad\":%lu,\"senders\":[",
                     (unsigned long)s_tx_queued, (unsigned long)s_tx_ok, (unsigned long)s_tx_timeout,
                     (unsigned long)s_rx_bad);

    if (n < 0 || (size_t)n >= out_cap) {
        stats_unlock();
        out[0] = '\0';
        return 0;
    }

    size_t pos = (size_t)n;
    bool first = true;
    for (int i = 0; i < LORA_STATS_MAX_SENDERS; i++) {
        const lora_stats_sender_t *s = &s_senders[i];
        if (!s->used) {
            continue;
        }
        const int m = snprintf(out + pos, out_cap - pos,
                               "%s{\"sig\":\"%s\",\"first\":%lu,\"last\":%lu,\"missing\":%lu,\"rx\":%lu}",
                               first ? "" : ",", s->sig, (unsigned long)s->first_seq, (unsigned long)s->last_seq,
                               (unsigned long)s->missing, (unsigned long)s->rx_count);
        if (m < 0 || (size_t)m >= out_cap - pos) {
            break;
        }
        pos += (size_t)m;
        first = false;
    }

    if (pos + 1 >= out_cap) {
        stats_unlock();
        out[0] = '\0';
        return 0;
    }
    out[pos++] = ']';
    if (!lora_mesh_append_json(out, out_cap, &pos)) {
        stats_unlock();
        out[0] = '\0';
        return 0;
    }
    if (pos + 1 >= out_cap) {
        stats_unlock();
        out[0] = '\0';
        return 0;
    }
    out[pos++] = '}';
    out[pos] = '\0';
    stats_unlock();
    return pos;
}

#else /* !CONFIG_REGATTAONE_SX1262_ENABLE */

void lora_stats_set_stream_active(bool active)
{
    (void)active;
}

bool lora_stats_stream_active(void)
{
    return false;
}

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */
