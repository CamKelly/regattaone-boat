#include "lora_mesh.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_SX1262_ENABLE

#include "device_type.h"
#include "lora_stats.h"
#include "sx1262_lora.h"

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "lora_mesh";

#define LORA_MESH_LISTEN_US              (10LL * 1000000LL)
#define LORA_MESH_HEARTBEAT_US           (15LL * 1000000LL)
#define LORA_MESH_HEARTBEAT_JITTER_US    (2LL * 1000000LL)
#define LORA_MESH_RECLAIM_US             (60LL * 1000000LL)
#define LORA_MESH_COLLISION_BACKOFF_MIN_US (1LL * 1000000LL)
#define LORA_MESH_COLLISION_BACKOFF_MAX_US (5LL * 1000000LL)
#define LORA_MESH_ID_MIN                 1U
#define LORA_MESH_ID_MAX                 65535U
#define LORA_MESH_PICK_ATTEMPTS          128
#define LORA_MESH_RX_MSG_MAX             16

typedef struct lora_mesh_rx_msg {
    uint16_t from_id;
    char text[LORA_MESH_MSG_MAX + 1];
    int64_t received_us;
} lora_mesh_rx_msg_t;

typedef struct lora_mesh_peer {
    uint16_t id;
    uint8_t type;
    int64_t last_heard_us;
    struct lora_mesh_peer *next;
} lora_mesh_peer_t;

static bool s_active;
static lora_mesh_state_t s_state;
static uint16_t s_my_id;
static int64_t s_listen_start_us;
static int64_t s_listen_duration_us;
static int64_t s_next_heartbeat_us;
static uint32_t s_tx_ok;
static uint32_t s_tx_fail;
static uint32_t s_rx_count;
static uint32_t s_collision_yield;
static uint32_t s_msg_tx_ok;
static uint32_t s_msg_tx_fail;
static uint32_t s_msg_rx;
static lora_mesh_peer_t *s_peers;
static lora_mesh_rx_msg_t s_rx_msgs[LORA_MESH_RX_MSG_MAX];
static size_t s_rx_msg_count;
static bool s_task_started;

static int64_t mesh_now_us(void)
{
    return (int64_t)esp_timer_get_time();
}

static lora_mesh_peer_t *peer_find(uint16_t id)
{
    for (lora_mesh_peer_t *p = s_peers; p != NULL; p = p->next) {
        if (p->id == id) {
            return p;
        }
    }
    return NULL;
}

static void peer_remove(lora_mesh_peer_t *victim)
{
    lora_mesh_peer_t **pp = &s_peers;
    while (*pp != NULL) {
        if (*pp == victim) {
            *pp = victim->next;
            free(victim);
            return;
        }
        pp = &(*pp)->next;
    }
}

static void peer_upsert(uint16_t id, uint8_t type, int64_t now_us)
{
    lora_mesh_peer_t *p = peer_find(id);
    if (p == NULL) {
        p = (lora_mesh_peer_t *)calloc(1, sizeof(*p));
        if (p == NULL) {
            ESP_LOGW(TAG, "peer alloc failed id=%u", (unsigned)id);
            return;
        }
        p->id = id;
        p->next = s_peers;
        s_peers = p;
    }
    p->type = type;
    p->last_heard_us = now_us;
}

static void peer_prune_stale(int64_t now_us)
{
    lora_mesh_peer_t *p = s_peers;
    while (p != NULL) {
        lora_mesh_peer_t *next = p->next;
        if (now_us - p->last_heard_us > LORA_MESH_RECLAIM_US) {
            ESP_LOGI(TAG, "reclaim peer id=%u", (unsigned)p->id);
            peer_remove(p);
        }
        p = next;
    }
}

static void peers_clear(void)
{
    while (s_peers != NULL) {
        lora_mesh_peer_t *n = s_peers->next;
        free(s_peers);
        s_peers = n;
    }
}

static void rx_msgs_clear(void)
{
    s_rx_msg_count = 0;
}

static void rx_msg_push(uint16_t from_id, const char *text, size_t text_len, int64_t now_us)
{
    if (text == NULL || text_len == 0 || text_len > LORA_MESH_MSG_MAX) {
        return;
    }
    if (s_rx_msg_count >= LORA_MESH_RX_MSG_MAX) {
        memmove(&s_rx_msgs[0], &s_rx_msgs[1], (LORA_MESH_RX_MSG_MAX - 1) * sizeof(s_rx_msgs[0]));
        s_rx_msg_count = LORA_MESH_RX_MSG_MAX - 1;
    }
    lora_mesh_rx_msg_t *m = &s_rx_msgs[s_rx_msg_count++];
    m->from_id = from_id;
    memcpy(m->text, text, text_len);
    m->text[text_len] = '\0';
    m->received_us = now_us;
}

static bool json_escape_append(char *out, size_t out_cap, size_t *pos, const char *text)
{
    if (text == NULL) {
        return true;
    }
    for (const char *p = text; *p != '\0'; p++) {
        char esc[8];
        const char *emit = esc;
        size_t emit_len = 0;
        if (*p == '\"' || *p == '\\') {
            esc[0] = '\\';
            esc[1] = *p;
            esc[2] = '\0';
            emit_len = 2;
        } else if (*p == '\n') {
            memcpy(esc, "\\n", 3);
            emit_len = 2;
        } else if (*p == '\r') {
            memcpy(esc, "\\r", 3);
            emit_len = 2;
        } else if ((unsigned char)*p < 0x20U) {
            continue;
        } else {
            emit = p;
            emit_len = 1;
        }
        if (*pos + emit_len >= out_cap) {
            return false;
        }
        memcpy(out + *pos, emit, emit_len);
        *pos += emit_len;
    }
    return true;
}

static bool id_is_known(uint16_t id, int64_t now_us)
{
    if (id < LORA_MESH_ID_MIN) {
        return true;
    }
    const lora_mesh_peer_t *p = peer_find(id);
    if (p != NULL && now_us - p->last_heard_us <= LORA_MESH_RECLAIM_US) {
        return true;
    }
    if (s_state == LORA_MESH_STATE_LOCKED && s_my_id == id) {
        return true;
    }
    return false;
}

static uint16_t pick_random_id(int64_t now_us)
{
    for (int attempt = 0; attempt < LORA_MESH_PICK_ATTEMPTS; attempt++) {
        const uint32_t raw = (uint32_t)esp_random();
        const uint16_t id = (uint16_t)(LORA_MESH_ID_MIN + (raw % (LORA_MESH_ID_MAX - LORA_MESH_ID_MIN + 1U)));
        if (!id_is_known(id, now_us)) {
            return id;
        }
    }
    for (uint32_t id = LORA_MESH_ID_MIN; id <= LORA_MESH_ID_MAX; id++) {
        if (!id_is_known((uint16_t)id, now_us)) {
            return (uint16_t)id;
        }
    }
    return 0;
}

static void schedule_next_heartbeat(int64_t now_us)
{
    const int32_t jitter = (int32_t)(esp_random() % (uint32_t)(2LL * LORA_MESH_HEARTBEAT_JITTER_US + 1LL))
                           - (int32_t)LORA_MESH_HEARTBEAT_JITTER_US;
    s_next_heartbeat_us = now_us + LORA_MESH_HEARTBEAT_US + (int64_t)jitter;
}

static void lock_id(uint16_t id, int64_t now_us)
{
    s_my_id = id;
    s_state = LORA_MESH_STATE_LOCKED;
    /* Send first heartbeat on next tick — not 15 s later. */
    s_next_heartbeat_us = now_us;
    ESP_LOGI(TAG, "locked mesh id=%u type=%u", (unsigned)id, (unsigned)device_type_get());
    lora_stats_request_notify();
}

static void begin_listening(int64_t now_us, int64_t duration_us)
{
    s_state = LORA_MESH_STATE_LISTENING;
    s_my_id = 0;
    s_listen_start_us = now_us;
    s_listen_duration_us = duration_us;
    s_next_heartbeat_us = 0;
    ESP_LOGI(TAG, "mesh listening (%lld ms)", (long long)(duration_us / 1000LL));
    lora_stats_request_notify();
}

static void try_claim_after_listen(int64_t now_us)
{
    peer_prune_stale(now_us);

    uint16_t id = pick_random_id(now_us);
    if (id == 0) {
        id = LORA_MESH_ID_MIN;
    }

    if (id == 0) {
        ESP_LOGW(TAG, "no free mesh id — retry listen");
        begin_listening(now_us, LORA_MESH_LISTEN_US);
        return;
    }

    lock_id(id, now_us);
}

static void yield_and_repick(int64_t now_us)
{
    s_collision_yield++;
    ESP_LOGW(TAG, "collision on id=%u — backoff then repick", (unsigned)s_my_id);

    const uint32_t span = (uint32_t)(LORA_MESH_COLLISION_BACKOFF_MAX_US - LORA_MESH_COLLISION_BACKOFF_MIN_US);
    const int64_t backoff_us = LORA_MESH_COLLISION_BACKOFF_MIN_US + (int64_t)(esp_random() % (span + 1U));
    begin_listening(now_us, backoff_us);
}

static const char *state_name(lora_mesh_state_t st)
{
    switch (st) {
    case LORA_MESH_STATE_LISTENING:
        return "listening";
    case LORA_MESH_STATE_LOCKED:
        return "locked";
    default:
        return "off";
    }
}

void lora_mesh_init(void) {}

void lora_mesh_set_active(bool active)
{
    if (active == s_active) {
        return;
    }

    s_active = active;
    if (!active) {
        s_state = LORA_MESH_STATE_OFF;
        s_my_id = 0;
        s_listen_start_us = 0;
        s_next_heartbeat_us = 0;
        peers_clear();
        rx_msgs_clear();
        s_msg_tx_ok = 0;
        s_msg_tx_fail = 0;
        s_msg_rx = 0;
        ESP_LOGI(TAG, "mesh off");
        lora_stats_request_notify();
        return;
    }

    lora_stats_set_stream_active(false);
    sx1262_lora_clear_tx_queue();
    begin_listening(mesh_now_us(), LORA_MESH_LISTEN_US);
    ESP_LOGI(TAG, "mesh on");
}

bool lora_mesh_active(void)
{
    return s_active;
}

lora_mesh_state_t lora_mesh_get_state(void)
{
    return s_active ? s_state : LORA_MESH_STATE_OFF;
}

static bool parse_heartbeat(const uint8_t *data, size_t len, uint16_t *id_out, uint8_t *type_out)
{
    if (data == NULL || len < LORA_MESH_PKT_LEN || data[0] != LORA_MESH_MAGIC) {
        return false;
    }
    *id_out = (uint16_t)(((uint16_t)data[1] << 8) | data[2]);
    *type_out = data[3];
    return *id_out >= LORA_MESH_ID_MIN;
}

static void on_rx_heartbeat(const uint8_t *data, size_t len, int64_t now_us)
{
    uint16_t id;
    uint8_t type;
    if (!parse_heartbeat(data, len, &id, &type)) {
        return;
    }

    s_rx_count++;
    lora_stats_mesh_rx_heartbeat();

    if (s_state == LORA_MESH_STATE_LOCKED && id == s_my_id) {
        yield_and_repick(now_us);
        return;
    }

    peer_upsert(id, type, now_us);
    ESP_LOGI(TAG, "heartbeat rx id=%u type=%u", (unsigned)id, (unsigned)type);
    lora_stats_request_notify();
}

static void on_rx_unicast(const uint8_t *data, size_t len, int64_t now_us)
{
    if (data == NULL || len < LORA_MESH_UNICAST_HDR_LEN || data[0] != LORA_MESH_UNICAST_MAGIC) {
        return;
    }
    if (s_state != LORA_MESH_STATE_LOCKED) {
        return;
    }

    const uint16_t dst = (uint16_t)(((uint16_t)data[1] << 8) | data[2]);
    const uint16_t src = (uint16_t)(((uint16_t)data[3] << 8) | data[4]);
    if (dst != s_my_id || src < LORA_MESH_ID_MIN) {
        return;
    }

    const size_t payload_len = len - LORA_MESH_UNICAST_HDR_LEN;
    if (payload_len == 0 || payload_len > LORA_MESH_MSG_MAX) {
        return;
    }

    char text[LORA_MESH_MSG_MAX + 1];
    memcpy(text, data + LORA_MESH_UNICAST_HDR_LEN, payload_len);
    text[payload_len] = '\0';

    s_msg_rx++;
    rx_msg_push(src, text, payload_len, now_us);
    ESP_LOGI(TAG, "unicast from id=%u: %.*s", (unsigned)src, (int)payload_len, text);
    lora_stats_request_notify();
}

void lora_mesh_on_rx(const uint8_t *data, size_t len, int64_t now_us)
{
    if (!s_active || data == NULL || len == 0) {
        return;
    }

    if (data[0] == LORA_MESH_MAGIC) {
        on_rx_heartbeat(data, len, now_us);
    } else if (data[0] == LORA_MESH_UNICAST_MAGIC) {
        on_rx_unicast(data, len, now_us);
    }
}

static esp_err_t send_unicast(uint16_t dest_id, const char *text, size_t text_len)
{
    if (!s_active || s_state != LORA_MESH_STATE_LOCKED || dest_id < LORA_MESH_ID_MIN) {
        return ESP_ERR_INVALID_STATE;
    }
    if (text == NULL || text_len == 0 || text_len > LORA_MESH_MSG_MAX) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t pkt[LORA_MESH_UNICAST_HDR_LEN + LORA_MESH_MSG_MAX];
    pkt[0] = LORA_MESH_UNICAST_MAGIC;
    pkt[1] = (uint8_t)(dest_id >> 8);
    pkt[2] = (uint8_t)(dest_id & 0xFF);
    pkt[3] = (uint8_t)(s_my_id >> 8);
    pkt[4] = (uint8_t)(s_my_id & 0xFF);
    memcpy(pkt + LORA_MESH_UNICAST_HDR_LEN, text, text_len);

    const esp_err_t err = sx1262_lora_mesh_transmit(pkt, LORA_MESH_UNICAST_HDR_LEN + text_len);
    if (err == ESP_OK) {
        s_msg_tx_ok++;
        ESP_LOGI(TAG, "unicast to id=%u (%u bytes)", (unsigned)dest_id, (unsigned)text_len);
    } else {
        s_msg_tx_fail++;
        ESP_LOGW(TAG, "unicast to id=%u failed: %s", (unsigned)dest_id, esp_err_to_name(err));
    }
    lora_stats_request_notify();
    return err;
}

esp_err_t lora_mesh_stats_write(const char *buf, size_t len)
{
    if (buf == NULL || len < 10 || strncmp(buf, "mesh_tx=", 8) != 0) {
        return ESP_ERR_NOT_FOUND;
    }

    const char *id_start = buf + 8;
    char *end = NULL;
    const unsigned long id_ul = strtoul(id_start, &end, 10);
    if (end == id_start || *end != '\n' || id_ul < LORA_MESH_ID_MIN || id_ul > LORA_MESH_ID_MAX) {
        return ESP_ERR_INVALID_ARG;
    }

    const char *text = end + 1;
    const size_t text_len = strlen(text);
    if (text_len == 0 || text_len > LORA_MESH_MSG_MAX) {
        return ESP_ERR_INVALID_ARG;
    }

    return send_unicast((uint16_t)id_ul, text, text_len);
}

void lora_mesh_build_heartbeat(uint8_t out[LORA_MESH_PKT_LEN])
{
    out[0] = LORA_MESH_MAGIC;
    out[1] = (uint8_t)(s_my_id >> 8);
    out[2] = (uint8_t)(s_my_id & 0xFF);
    out[3] = (uint8_t)device_type_get();
}

bool lora_mesh_heartbeat_due(int64_t now_us)
{
    return s_active && s_state == LORA_MESH_STATE_LOCKED && s_next_heartbeat_us > 0
           && now_us >= s_next_heartbeat_us;
}

void lora_mesh_tick(int64_t now_us)
{
    if (!s_active) {
        return;
    }

    peer_prune_stale(now_us);

    if (s_state == LORA_MESH_STATE_LISTENING) {
        if (now_us - s_listen_start_us >= s_listen_duration_us) {
            try_claim_after_listen(now_us);
        }
        return;
    }

    if (s_state == LORA_MESH_STATE_LOCKED && lora_mesh_heartbeat_due(now_us)) {
        uint8_t pkt[LORA_MESH_PKT_LEN];
        lora_mesh_build_heartbeat(pkt);
        const esp_err_t err = sx1262_lora_mesh_transmit(pkt, sizeof(pkt));
        if (err == ESP_OK) {
            s_tx_ok++;
            lora_stats_mesh_tx_ok();
            ESP_LOGI(TAG, "heartbeat tx id=%u", (unsigned)s_my_id);
        } else {
            s_tx_fail++;
            lora_stats_mesh_tx_fail();
            ESP_LOGW(TAG, "heartbeat tx id=%u failed: %s", (unsigned)s_my_id, esp_err_to_name(err));
            /* Retry soon after CAD/busy failure instead of waiting 15 s. */
            s_next_heartbeat_us = now_us + 500000LL;
        }
        if (err == ESP_OK) {
            schedule_next_heartbeat(now_us);
        }
        lora_stats_request_notify();
    }
}

bool lora_mesh_append_json(char *out, size_t out_cap, size_t *pos)
{
    if (out == NULL || pos == NULL || *pos >= out_cap) {
        return false;
    }

    const int64_t now_us = mesh_now_us();
    const char *st = s_active ? state_name(s_state) : "off";
    const device_type_t my_type = device_type_get();

    int n;
    if (s_state == LORA_MESH_STATE_LOCKED) {
        n = snprintf(out + *pos, out_cap - *pos,
                     ",\"mesh\":{\"active\":%s,\"state\":\"%s\",\"my_id\":%u,\"my_type\":%u,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu",
                     s_active ? "true" : "false", st, (unsigned)s_my_id, (unsigned)my_type,
                     (unsigned long)s_tx_ok, (unsigned long)s_tx_fail, (unsigned long)s_rx_count);
    } else {
        n = snprintf(out + *pos, out_cap - *pos,
                     ",\"mesh\":{\"active\":%s,\"state\":\"%s\",\"my_id\":null,\"my_type\":%u,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu",
                     s_active ? "true" : "false", st, (unsigned)my_type, (unsigned long)s_tx_ok,
                     (unsigned long)s_tx_fail, (unsigned long)s_rx_count);
    }
    if (n < 0 || (size_t)n >= out_cap - *pos) {
        return false;
    }
    *pos += (size_t)n;

    if (s_collision_yield > 0) {
        n = snprintf(out + *pos, out_cap - *pos, ",\"collision_yield\":%lu", (unsigned long)s_collision_yield);
        if (n < 0 || (size_t)n >= out_cap - *pos) {
            return false;
        }
        *pos += (size_t)n;
    }
    if (s_msg_tx_ok > 0 || s_msg_tx_fail > 0 || s_msg_rx > 0) {
        n = snprintf(out + *pos, out_cap - *pos, ",\"msg_tx_ok\":%lu,\"msg_tx_fail\":%lu,\"msg_rx\":%lu",
                     (unsigned long)s_msg_tx_ok, (unsigned long)s_msg_tx_fail, (unsigned long)s_msg_rx);
        if (n < 0 || (size_t)n >= out_cap - *pos) {
            return false;
        }
        *pos += (size_t)n;
    }
    if (*pos + 10 >= out_cap) {
        return false;
    }
    memcpy(out + *pos, ",\"peers\":[", 10);
    *pos += 10;

    bool first = true;
    for (const lora_mesh_peer_t *p = s_peers; p != NULL; p = p->next) {
        if (s_state == LORA_MESH_STATE_LOCKED && p->id == s_my_id) {
            continue;
        }
        const int64_t age_ms = (now_us - p->last_heard_us) / 1000LL;
        const int m = snprintf(out + *pos, out_cap - *pos, "%s{\"id\":%u,\"type\":%u,\"last_ms\":%lld}",
                               first ? "" : ",", (unsigned)p->id, (unsigned)p->type, (long long)age_ms);
        if (m < 0 || (size_t)m >= out_cap - *pos) {
            return false;
        }
        *pos += (size_t)m;
        first = false;
    }

    if (*pos + 2 >= out_cap) {
        return false;
    }
    out[(*pos)++] = ']';

    if (s_rx_msg_count == 0) {
        if (*pos + 1 >= out_cap) {
            return false;
        }
        out[(*pos)++] = '}';
        return true;
    }

    const size_t rx_msgs_start = *pos;
    if (*pos + 14 >= out_cap) {
        return false;
    }
    memcpy(out + *pos, ",\"rx_msgs\":[", 13);
    *pos += 13;

    first = true;
    for (size_t mi = 0; mi < s_rx_msg_count; mi++) {
        const lora_mesh_rx_msg_t *m = &s_rx_msgs[mi];
        const int64_t age_ms = (now_us - m->received_us) / 1000LL;
        int hdr = snprintf(out + *pos, out_cap - *pos, "%s{\"from\":%u,\"text\":\"", first ? "" : ",",
                           (unsigned)m->from_id);
        if (hdr < 0 || (size_t)hdr >= out_cap - *pos) {
            goto rx_msgs_done;
        }
        *pos += (size_t)hdr;
        if (!json_escape_append(out, out_cap, pos, m->text)) {
            goto rx_msgs_done;
        }
        hdr = snprintf(out + *pos, out_cap - *pos, "\",\"last_ms\":%lld}", (long long)age_ms);
        if (hdr < 0 || (size_t)hdr >= out_cap - *pos) {
            goto rx_msgs_done;
        }
        *pos += (size_t)hdr;
        first = false;
    }

rx_msgs_done:
    if (first) {
        *pos = rx_msgs_start;
        if (*pos + 12 >= out_cap) {
            return false;
        }
        memcpy(out + *pos, ",\"rx_msgs\":[]", 12);
        *pos += 12;
    } else if (*pos + 1 >= out_cap) {
        return false;
    } else {
        out[(*pos)++] = ']';
    }

    if (*pos + 1 >= out_cap) {
        return false;
    }
    out[(*pos)++] = '}';
    return true;
}

static void lora_mesh_task(void *arg)
{
    (void)arg;
    for (;;) {
        if (s_active) {
            lora_mesh_tick(mesh_now_us());
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void lora_mesh_start_task(void)
{
    if (s_task_started) {
        return;
    }
    s_task_started = true;
    xTaskCreate(lora_mesh_task, "lora_mesh", 4096, NULL, 4, NULL);
}

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */
