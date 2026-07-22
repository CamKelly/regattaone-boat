#include "meshtastic_client.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE

#include "ble_sen0140.h"
#include "mark_broadcast.h"
#include "meshtastic_uart.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

static const char *TAG = "mt_client";

#define MT_BROADCAST 0xFFFFFFFFU
#define MT_TEXT_APP 1U
#define MT_POSITION_APP 3U
#define MT_PRIVATE_APP 256U
#define MT_TRANSPORT_LORA 1U
#define MT_TRANSPORT_API 7U
#define MT_MESHPACKET_TRANSPORT_FIELD 21U
#define MT_NODE_MAX 48U
#define MT_RX_MSG_MAX 16U
#define MT_NAME_MAX 32U
#define MT_TEXT_MAX 240U
#define MT_JSON_TEXT_MAX 120U
/** Truncate RX text in BLE stats JSON — keeps payload under one notify when possible. */
#define MT_BLE_JSON_TEXT_MAX 48U
/** Cap roster nodes in BLE stats JSON so paced notifies finish before the next 1 Hz push. */
#define MT_BLE_JSON_NODE_MAX 8U
#define MT_FRAME_HDR 4U
#define MT_FRAME_MAX 512U
#define MT_PROTO_MAX (MT_FRAME_MAX - MT_FRAME_HDR)
#define MT_RX_ASM_MAX 4096U
#define MT_WANT_CONFIG_RETRY_MS 10000

typedef struct {
    uint32_t num;
    char long_name[MT_NAME_MAX];
    char short_name[8];
    int64_t last_heard_us;
    bool has_pos;
    bool has_gps_update;
    double lat_deg;
    double lon_deg;
    int32_t alt_m;
    float speed_mps;
    float heading_deg;
    uint32_t fix_quality;
    uint32_t fix_type;
    uint32_t sats_in_view;
    uint32_t seq_number;
    uint32_t time_sec;
    uint32_t timestamp_sec;
    bool gps_has_lock;
    bool used;
} mt_node_t;

typedef struct {
    uint32_t from;
    char from_name[MT_NAME_MAX];
    char text[MT_TEXT_MAX];
    int64_t received_us;
} mt_rx_msg_t;

typedef struct {
    const uint8_t *data;
    size_t len;
    size_t pos;
} pb_buf_t;

static SemaphoreHandle_t s_mtx;
static TaskHandle_t s_task;
static uint8_t s_rx_asm[MT_RX_ASM_MAX];
static size_t s_rx_asm_len;

static uint32_t s_want_config_id;
static bool s_config_complete;
static bool s_data_flowing;
static int64_t s_last_want_config_us;
static uint32_t s_my_num;
static bool s_have_my_num;

static mt_node_t s_nodes[MT_NODE_MAX];
static mt_rx_msg_t s_rx_msgs[MT_RX_MSG_MAX];
static size_t s_rx_msg_count;

static uint32_t s_tx_ok;
static uint32_t s_tx_fail;
static uint32_t s_rx_count;
static uint32_t s_gps_rx;
static uint32_t s_gps_api_rx;
static int64_t s_last_stats_notify_us;
static bool s_stats_notify_busy;
static bool s_stats_notify_pending;
static bool s_stats_notify_force;
static bool s_stats_dirty;

/** Min gap between chunked BLE stats notifies (GPS can mark dirty every packet). */
#define MT_STATS_BLE_MIN_INTERVAL_US 2000000LL

static mt_node_t *node_find(uint32_t num);
static mt_node_t *node_alloc(uint32_t num);
static void stats_notify_send(bool force);
void meshtastic_client_request_stats_notify_now(void);

static int64_t mt_now_us(void)
{
    return esp_timer_get_time();
}

static void mt_lock(void)
{
    if (s_mtx != NULL) {
        xSemaphoreTake(s_mtx, portMAX_DELAY);
    }
}

static void mt_unlock(void)
{
    if (s_mtx != NULL) {
        xSemaphoreGive(s_mtx);
    }
}

static void mt_notify_line(const char *line)
{
    if (line == NULL) {
        return;
    }
    ble_sen0140_meshtastic_rx_notify((const uint8_t *)line, strlen(line));
}

static void mt_touch_self_node(void)
{
    if (!s_have_my_num) {
        return;
    }
    mt_node_t *node = node_alloc(s_my_num);
    if (node == NULL) {
        return;
    }
    node->last_heard_us = mt_now_us();
    if (node->long_name[0] == '\0') {
        snprintf(node->long_name, sizeof(node->long_name), "0x%08lX", (unsigned long)s_my_num);
    }
    s_stats_dirty = true;
}

static bool pb_read_varint(pb_buf_t *b, uint64_t *out)
{
    uint64_t val = 0;
    unsigned shift = 0;
    while (b->pos < b->len) {
        const uint8_t byte = b->data[b->pos++];
        val |= (uint64_t)(byte & 0x7FU) << shift;
        if ((byte & 0x80U) == 0U) {
            *out = val;
            return true;
        }
        shift += 7U;
        if (shift > 63U) {
            return false;
        }
    }
    return false;
}

static bool pb_read_tag(pb_buf_t *b, uint32_t *field, uint32_t *wire)
{
    uint64_t tag = 0;
    if (!pb_read_varint(b, &tag)) {
        return false;
    }
    *wire = (uint32_t)(tag & 7U);
    *field = (uint32_t)(tag >> 3);
    return true;
}

static bool pb_skip(pb_buf_t *b, uint32_t wire)
{
    uint64_t tmp = 0;
    switch (wire) {
    case 0:
        return pb_read_varint(b, &tmp);
    case 1:
        if (b->pos + 8U > b->len) {
            return false;
        }
        b->pos += 8U;
        return true;
    case 2: {
        if (!pb_read_varint(b, &tmp) || tmp > (b->len - b->pos)) {
            return false;
        }
        b->pos += (size_t)tmp;
        return true;
    }
    case 5:
        if (b->pos + 4U > b->len) {
            return false;
        }
        b->pos += 4U;
        return true;
    default:
        return false;
    }
}

static bool pb_read_delimited(pb_buf_t *b, pb_buf_t *sub)
{
    uint64_t len = 0;
    if (!pb_read_varint(b, &len) || len > (b->len - b->pos)) {
        return false;
    }
    sub->data = b->data + b->pos;
    sub->len = (size_t)len;
    sub->pos = 0;
    b->pos += (size_t)len;
    return true;
}

static size_t pb_encode_varint(uint8_t *out, size_t cap, uint64_t val)
{
    size_t n = 0;
    while (val >= 0x80U) {
        if (n >= cap) {
            return 0;
        }
        out[n++] = (uint8_t)((val & 0x7FU) | 0x80U);
        val >>= 7;
    }
    if (n >= cap) {
        return 0;
    }
    out[n++] = (uint8_t)val;
    return n;
}

static bool pb_extract_uint32(const uint8_t *data, size_t len, uint32_t want_field, uint32_t *out)
{
    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            return false;
        }
        if (field == want_field && wire == 0U) {
            uint64_t val = 0;
            if (!pb_read_varint(&b, &val)) {
                return false;
            }
            *out = (uint32_t)val;
            return true;
        }
        if (!pb_skip(&b, wire)) {
            return false;
        }
    }
    return false;
}

static bool pb_extract_fixed32(const uint8_t *data, size_t len, uint32_t want_field, uint32_t *out)
{
    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            return false;
        }
        if (field == want_field && wire == 5U) {
            if (b.pos + 4U > b.len) {
                return false;
            }
            memcpy(out, b.data + b.pos, 4U);
            b.pos += 4U;
            return true;
        }
        if (!pb_skip(&b, wire)) {
            return false;
        }
    }
    return false;
}

static bool pb_extract_sfixed32(const uint8_t *data, size_t len, uint32_t want_field, int32_t *out)
{
    uint32_t raw = 0;
    if (!pb_extract_fixed32(data, len, want_field, &raw)) {
        return false;
    }
    *out = (int32_t)raw;
    return true;
}

static bool pb_extract_int32(const uint8_t *data, size_t len, uint32_t want_field, int32_t *out)
{
    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            return false;
        }
        if (field == want_field && wire == 0U) {
            uint64_t val = 0;
            if (!pb_read_varint(&b, &val)) {
                return false;
            }
            *out = (int32_t)val;
            return true;
        }
        if (!pb_skip(&b, wire)) {
            return false;
        }
    }
    return false;
}

static bool pb_extract_string(const uint8_t *data, size_t len, uint32_t want_field, char *out, size_t out_cap)
{
    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            return false;
        }
        if (field == want_field && wire == 2U) {
            uint64_t slen = 0;
            if (!pb_read_varint(&b, &slen) || slen > (b.len - b.pos)) {
                return false;
            }
            size_t n = (size_t)slen;
            if (n >= out_cap) {
                n = out_cap - 1U;
            }
            memcpy(out, b.data + b.pos, n);
            out[n] = '\0';
            return true;
        }
        if (!pb_skip(&b, wire)) {
            return false;
        }
    }
    return false;
}

static bool pb_extract_bytes(const uint8_t *data, size_t len, uint32_t want_field, const uint8_t **ptr, size_t *out_len)
{
    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            return false;
        }
        if (field == want_field && wire == 2U) {
            uint64_t blen = 0;
            if (!pb_read_varint(&b, &blen) || blen > (b.len - b.pos)) {
                return false;
            }
            *ptr = b.data + b.pos;
            *out_len = (size_t)blen;
            return true;
        }
        if (!pb_skip(&b, wire)) {
            return false;
        }
    }
    return false;
}

static mt_node_t *node_find(uint32_t num)
{
    for (size_t i = 0; i < MT_NODE_MAX; i++) {
        if (s_nodes[i].used && s_nodes[i].num == num) {
            return &s_nodes[i];
        }
    }
    return NULL;
}

static mt_node_t *node_alloc(uint32_t num)
{
    mt_node_t *n = node_find(num);
    if (n != NULL) {
        return n;
    }
    for (size_t i = 0; i < MT_NODE_MAX; i++) {
        if (!s_nodes[i].used) {
            memset(&s_nodes[i], 0, sizeof(s_nodes[i]));
            s_nodes[i].used = true;
            s_nodes[i].num = num;
            return &s_nodes[i];
        }
    }
    return NULL;
}

static const char *node_label(uint32_t num, char *buf, size_t cap)
{
    const mt_node_t *n = node_find(num);
    if (n != NULL && n->long_name[0] != '\0') {
        return n->long_name;
    }
    snprintf(buf, cap, "0x%08lX", (unsigned long)num);
    return buf;
}

static void rx_msg_push(uint32_t from, const char *from_name, const char *text)
{
    if (text == NULL || text[0] == '\0') {
        return;
    }
    if (s_rx_msg_count >= MT_RX_MSG_MAX) {
        memmove(&s_rx_msgs[0], &s_rx_msgs[1], (MT_RX_MSG_MAX - 1U) * sizeof(s_rx_msgs[0]));
        s_rx_msg_count = MT_RX_MSG_MAX - 1U;
    }
    mt_rx_msg_t *m = &s_rx_msgs[s_rx_msg_count++];
    memset(m, 0, sizeof(*m));
    m->from = from;
    m->received_us = mt_now_us();
    if (from_name != NULL) {
        strncpy(m->from_name, from_name, sizeof(m->from_name) - 1U);
    }
    strncpy(m->text, text, sizeof(m->text) - 1U);
}

static bool json_escape_append(char *out, size_t cap, size_t *pos, const char *text, size_t max_run)
{
    if (out == NULL || pos == NULL || *pos >= cap) {
        return false;
    }
    size_t n = 0;
    if (text != NULL) {
        n = strlen(text);
        if (n > max_run) {
            n = max_run;
        }
    }
    for (size_t i = 0; i < n; i++) {
        const char c = text[i];
        char esc[3] = {0};
        size_t elen = 1;
        if (c == '"' || c == '\\') {
            esc[0] = '\\';
            esc[1] = c;
            elen = 2;
        } else if ((unsigned char)c < 0x20U) {
            continue;
        } else {
            esc[0] = c;
        }
        if (*pos + elen >= cap) {
            return false;
        }
        memcpy(out + *pos, esc, elen);
        *pos += elen;
    }
    return true;
}

static bool json_escape_append_trunc(char *out, size_t cap, size_t *pos, const char *text, size_t max_len)
{
    if (text == NULL) {
        return true;
    }
    size_t n = strlen(text);
    if (n > max_len) {
        n = max_len;
    }
    char tmp[64];
    if (n >= sizeof(tmp)) {
        n = sizeof(tmp) - 1U;
    }
    memcpy(tmp, text, n);
    tmp[n] = '\0';
    return json_escape_append(out, cap, pos, tmp, n);
}

static esp_err_t uart_send_frame(const uint8_t *proto, size_t proto_len)
{
    if (proto_len == 0U || proto_len > MT_PROTO_MAX) {
        return ESP_ERR_INVALID_SIZE;
    }
    uint8_t frame[MT_FRAME_MAX];
    frame[0] = 0x94U;
    frame[1] = 0xC3U;
    frame[2] = (uint8_t)((proto_len >> 8) & 0xFFU);
    frame[3] = (uint8_t)(proto_len & 0xFFU);
    memcpy(frame + MT_FRAME_HDR, proto, proto_len);
    return meshtastic_uart_write(frame, MT_FRAME_HDR + proto_len);
}

/** Send ToRadio.want_config_id until FromRadio data is flowing (or force=true for BLE reconnect). */
static esp_err_t send_want_config(bool force)
{
    if (s_config_complete && !force) {
        return ESP_OK;
    }
    s_want_config_id++;
    if (s_want_config_id == 0U) {
        s_want_config_id = 1U;
    }
    s_config_complete = false;
    uint8_t proto[16];
    size_t n = 0;
    proto[n++] = 0x18U;
    n += pb_encode_varint(proto + n, sizeof(proto) - n, s_want_config_id);
    ESP_LOGI(TAG, "want_config_id=%lu%s", (unsigned long)s_want_config_id,
             force ? " (reconnect)" : (s_last_want_config_us ? " (retry)" : " (boot)"));
    s_last_want_config_us = mt_now_us();
    return uart_send_frame(proto, n);
}

static size_t encode_data_text(const char *text, uint8_t *out, size_t cap)
{
    const size_t tlen = strlen(text);
    if (tlen == 0U || tlen > MT_TEXT_MAX) {
        return 0;
    }
    size_t n = 0;
    out[n++] = 0x08U;
    n += pb_encode_varint(out + n, cap - n, MT_TEXT_APP);
    out[n++] = 0x12U;
    n += pb_encode_varint(out + n, cap - n, tlen);
    if (n + tlen > cap) {
        return 0;
    }
    memcpy(out + n, text, tlen);
    n += tlen;
    return n;
}

static size_t encode_data_bytes(uint32_t portnum, const uint8_t *payload, size_t plen, uint8_t *out, size_t cap)
{
    if (payload == NULL || plen == 0U || plen > MT_TEXT_MAX) {
        return 0;
    }
    size_t n = 0;
    out[n++] = 0x08U;
    n += pb_encode_varint(out + n, cap - n, portnum);
    out[n++] = 0x12U;
    n += pb_encode_varint(out + n, cap - n, plen);
    if (n + plen > cap) {
        return 0;
    }
    memcpy(out + n, payload, plen);
    n += plen;
    return n;
}

static esp_err_t send_bytes_packet(uint32_t dest, uint32_t portnum, const uint8_t *payload, size_t plen)
{
    if (!s_config_complete) {
        ESP_LOGW(TAG, "binary send blocked: config not ready");
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t data[MT_TEXT_MAX + 16U];
    const size_t data_len = encode_data_bytes(portnum, payload, plen, data, sizeof(data));
    if (data_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t packet[MT_TEXT_MAX + 32U];
    size_t n = 0;
    packet[n++] = 0x15U;
    memcpy(packet + n, &dest, 4U);
    n += 4U;
    packet[n++] = 0x22U;
    n += pb_encode_varint(packet + n, sizeof(packet) - n, data_len);
    if (n + data_len > sizeof(packet)) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(packet + n, data, data_len);
    n += data_len;
    packet[n++] = 0x50U;
    n += pb_encode_varint(packet + n, sizeof(packet) - n, 1U);

    uint8_t toradio[MT_TEXT_MAX + 40U];
    size_t m = 0;
    toradio[m++] = 0x0AU;
    m += pb_encode_varint(toradio + m, sizeof(toradio) - m, n);
    if (m + n > sizeof(toradio)) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(toradio + m, packet, n);
    m += n;

    const esp_err_t err = uart_send_frame(toradio, m);
    if (err == ESP_OK) {
        s_tx_ok++;
        ESP_LOGI(TAG, "TX binary port=%lu %u bytes to 0x%08lx", (unsigned long)portnum, (unsigned)plen,
                 (unsigned long)dest);
    } else {
        s_tx_fail++;
    }
    return err;
}

esp_err_t meshtastic_client_broadcast_bytes(const uint8_t *data, size_t len)
{
    return send_bytes_packet(MT_BROADCAST, MT_PRIVATE_APP, data, len);
}

static esp_err_t send_text_packet(uint32_t dest, const char *text)
{
    if (text == NULL || text[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (strncmp(text, "send=", 5) == 0) {
        ESP_LOGE(TAG, "refusing command string as mesh payload");
        mt_notify_line("! send rejected: use send=<dest>\\n<text> on BLE, not raw command on UART\n");
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_config_complete) {
        ESP_LOGW(TAG, "send blocked: config not ready");
        mt_notify_line("! send blocked: wait for config ready\n");
        return ESP_ERR_INVALID_STATE;
    }

    ESP_LOGI(TAG, "TX text to 0x%08lx: %s", (unsigned long)dest, text);

    uint8_t data[MT_TEXT_MAX + 16U];
    const size_t data_len = encode_data_text(text, data, sizeof(data));
    if (data_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t packet[MT_TEXT_MAX + 32U];
    size_t n = 0;
    packet[n++] = 0x15U;
    memcpy(packet + n, &dest, 4U);
    n += 4U;
    packet[n++] = 0x22U;
    n += pb_encode_varint(packet + n, sizeof(packet) - n, data_len);
    if (n + data_len > sizeof(packet)) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(packet + n, data, data_len);
    n += data_len;
    packet[n++] = 0x50U;
    n += pb_encode_varint(packet + n, sizeof(packet) - n, 1U);

    uint8_t toradio[MT_TEXT_MAX + 40U];
    size_t m = 0;
    toradio[m++] = 0x0AU;
    m += pb_encode_varint(toradio + m, sizeof(toradio) - m, n);
    if (m + n > sizeof(toradio)) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(toradio + m, packet, n);
    m += n;

    const esp_err_t err = uart_send_frame(toradio, m);
    if (err == ESP_OK) {
        s_tx_ok++;
        char label[16];
        char line[MT_TEXT_MAX + 64U];
        if (dest == MT_BROADCAST) {
            snprintf(line, sizeof(line), ">> broadcast: %s\n", text);
        } else {
            snprintf(line, sizeof(line), ">> %s: %s\n", node_label(dest, label, sizeof(label)), text);
        }
        mt_notify_line(line);
    } else {
        s_tx_fail++;
    }
    return err;
}

static void mt_apply_position(mt_node_t *node, const uint8_t *data, size_t len);

static void handle_mesh_packet(const uint8_t *data, size_t len)
{
    uint32_t from = 0;
    uint32_t to = 0;
    (void)pb_extract_fixed32(data, len, 1U, &from);

    const uint8_t *decoded = NULL;
    size_t decoded_len = 0;
    if (!pb_extract_bytes(data, len, 4U, &decoded, &decoded_len)) {
        return;
    }

    uint32_t transport = 0;
    (void)pb_extract_uint32(data, len, MT_MESHPACKET_TRANSPORT_FIELD, &transport);

    uint32_t portnum = 0;
    const uint8_t *payload = NULL;
    size_t payload_len = 0;
    if (!pb_extract_uint32(decoded, decoded_len, 1U, &portnum)) {
        return;
    }
    const bool have_payload = pb_extract_bytes(decoded, decoded_len, 2U, &payload, &payload_len);
    if (!have_payload) {
        payload = NULL;
        payload_len = 0;
    }

    (void)pb_extract_fixed32(data, len, 2U, &to);
    s_rx_count++;

    if (portnum == MT_POSITION_APP) {
        if (transport == MT_TRANSPORT_API) {
            s_gps_api_rx++;
            if (s_have_my_num) {
                if (from != 0U && from != s_my_num) {
                    return;
                }
                from = s_my_num;
            } else if (from == 0U) {
                return;
            }
        } else if (from == 0U && s_have_my_num) {
            from = s_my_num;
        }
        s_gps_rx++;
        mt_node_t *node = node_alloc(from);
        if (node != NULL) {
            node->last_heard_us = mt_now_us();
            if (node->long_name[0] == '\0') {
                snprintf(node->long_name, sizeof(node->long_name), "0x%08lX", (unsigned long)from);
            }
            mt_apply_position(node, payload, payload_len);
            s_stats_dirty = true;
            if (s_gps_rx <= 3U || (s_gps_rx % 30U) == 0U) {
                ESP_LOGI(TAG, "GPS rx #%lu from=0x%08lx transport=%lu fixq=%lu sats=%lu%s",
                         (unsigned long)s_gps_rx, (unsigned long)from, (unsigned long)transport,
                         (unsigned long)node->fix_quality, (unsigned long)node->sats_in_view,
                         node->has_pos ? " (fix)" : "");
            }
        }
        return;
    }

    if (portnum == MT_PRIVATE_APP) {
        if (payload != NULL && payload_len > 0U) {
            mark_broadcast_on_rx(payload, payload_len, from);
        }
        return;
    }

    if (portnum != MT_TEXT_APP) {
        return;
    }
    if (payload_len == 0U) {
        return;
    }

    mt_node_t *node = node_alloc(from);
    if (node != NULL) {
        node->last_heard_us = mt_now_us();
        if (node->long_name[0] == '\0') {
            snprintf(node->long_name, sizeof(node->long_name), "0x%08lX", (unsigned long)from);
        }
    }

    char text[MT_TEXT_MAX];
    size_t n = payload_len;
    if (n >= sizeof(text)) {
        n = sizeof(text) - 1U;
    }
    memcpy(text, payload, n);
    text[n] = '\0';

    char label[16];
    const char *name = node_label(from, label, sizeof(label));
    if (node != NULL && node->long_name[0] != '\0') {
        name = node->long_name;
    }
    rx_msg_push(from, name, text);

    char line[MT_TEXT_MAX + 64U];
    snprintf(line, sizeof(line), "<< %s: %s\n", name, text);
    mt_notify_line(line);
    s_stats_dirty = true;
}

static void mt_apply_position(mt_node_t *node, const uint8_t *data, size_t len)
{
    if (node == NULL) {
        return;
    }
    if (data == NULL || len == 0U) {
        node->has_gps_update = true;
        return;
    }

    int32_t lat_i = 0;
    int32_t lon_i = 0;
    int32_t alt_m = 0;
    uint32_t ground_speed = 0;
    uint32_t ground_track = 0;

    const bool have_lat = pb_extract_sfixed32(data, len, 1U, &lat_i);
    const bool have_lon = pb_extract_sfixed32(data, len, 2U, &lon_i);

    if (have_lat) {
        node->lat_deg = (double)lat_i / 10000000.0;
    }
    if (have_lon) {
        node->lon_deg = (double)lon_i / 10000000.0;
    }
    if (have_lat && have_lon && (lat_i != 0 || lon_i != 0)) {
        node->has_pos = true;
    }

    if (pb_extract_int32(data, len, 3U, &alt_m)) {
        node->alt_m = alt_m;
    }
    if (pb_extract_uint32(data, len, 15U, &ground_speed)) {
        node->speed_mps = (float)ground_speed / 100.0f;
    }
    if (pb_extract_uint32(data, len, 16U, &ground_track)) {
        node->heading_deg = (float)ground_track / 100000.0f;
    }

    uint32_t fix_quality = 0;
    if (pb_extract_uint32(data, len, 17U, &fix_quality)) {
        node->fix_quality = fix_quality;
    }
    uint32_t fix_type = 0;
    if (pb_extract_uint32(data, len, 18U, &fix_type)) {
        node->fix_type = fix_type;
    }
    uint32_t sats_in_view = 0;
    if (pb_extract_uint32(data, len, 19U, &sats_in_view)) {
        node->sats_in_view = sats_in_view;
    }
    uint32_t sensor_id = 0;
    if (pb_extract_uint32(data, len, 20U, &sensor_id)) {
        node->gps_has_lock = (sensor_id & 2U) != 0U;
    }
    uint32_t seq_number = 0;
    if (pb_extract_uint32(data, len, 22U, &seq_number)) {
        node->seq_number = seq_number;
    }
    uint32_t time_sec = 0;
    if (pb_extract_fixed32(data, len, 4U, &time_sec)) {
        node->time_sec = time_sec;
    }
    uint32_t timestamp_sec = 0;
    if (pb_extract_fixed32(data, len, 7U, &timestamp_sec)) {
        node->timestamp_sec = timestamp_sec;
    }

    node->has_gps_update = true;
}

static void handle_node_info(const uint8_t *data, size_t len)
{
    uint32_t num = 0;
    if (!pb_extract_uint32(data, len, 1U, &num)) {
        return;
    }
    mt_node_t *node = node_alloc(num);
    if (node == NULL) {
        return;
    }
    node->last_heard_us = mt_now_us();

    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            break;
        }
        if (field == 2U && wire == 2U) {
            pb_buf_t user = {0};
            if (pb_read_delimited(&b, &user)) {
                char long_name[MT_NAME_MAX];
                char short_name[8];
                if (pb_extract_string(user.data, user.len, 2U, long_name, sizeof(long_name))) {
                    strncpy(node->long_name, long_name, sizeof(node->long_name) - 1U);
                }
                if (pb_extract_string(user.data, user.len, 3U, short_name, sizeof(short_name))) {
                    strncpy(node->short_name, short_name, sizeof(node->short_name) - 1U);
                }
            }
            continue;
        }
        if (field == 3U && wire == 2U) {
            pb_buf_t pos = {0};
            if (pb_read_delimited(&b, &pos)) {
                mt_apply_position(node, pos.data, pos.len);
            }
            continue;
        }
        if (!pb_skip(&b, wire)) {
            break;
        }
    }
    s_stats_dirty = true;
}

static void handle_from_radio(const uint8_t *data, size_t len)
{
    pb_buf_t b = {.data = data, .len = len, .pos = 0};
    uint32_t field = 0;
    uint32_t wire = 0;
    while (b.pos < b.len) {
        if (!pb_read_tag(&b, &field, &wire)) {
            return;
        }
        if (field == 2U && wire == 2U) {
            pb_buf_t pkt = {0};
            if (pb_read_delimited(&b, &pkt)) {
                handle_mesh_packet(pkt.data, pkt.len);
            }
            continue;
        }
        if (field == 3U && wire == 2U) {
            pb_buf_t info = {0};
            if (pb_read_delimited(&b, &info)) {
                uint32_t my = 0;
                if (pb_extract_uint32(info.data, info.len, 1U, &my)) {
                    s_my_num = my;
                    s_have_my_num = true;
                    ESP_LOGI(TAG, "my_node_num=0x%08lx", (unsigned long)s_my_num);
                    mt_touch_self_node();
                }
            }
            continue;
        }
        if (field == 4U && wire == 2U) {
            pb_buf_t ni = {0};
            if (pb_read_delimited(&b, &ni)) {
                handle_node_info(ni.data, ni.len);
            }
            continue;
        }
        if (field == 7U && wire == 0U) {
            uint64_t cid = 0;
            if (pb_read_varint(&b, &cid) && (uint32_t)cid == s_want_config_id) {
                s_config_complete = true;
                ESP_LOGI(TAG, "config complete (want_config_id=%lu)", (unsigned long)s_want_config_id);
                mt_notify_line("! config ready\n");
                mt_touch_self_node();
                s_stats_dirty = true;
            }
            continue;
        }
        if (field == 8U && wire == 0U) {
            uint64_t rb = 0;
            if (pb_read_varint(&b, &rb) && rb != 0U) {
                mt_notify_line("! companion rebooted (not re-sending want_config)\n");
            }
            continue;
        }
        if (!pb_skip(&b, wire)) {
            return;
        }
    }
}

static void consume_frames(void)
{
    while (s_rx_asm_len >= MT_FRAME_HDR) {
        if (s_rx_asm[0] != 0x94U || s_rx_asm[1] != 0xC3U) {
            memmove(s_rx_asm, s_rx_asm + 1U, s_rx_asm_len - 1U);
            s_rx_asm_len--;
            continue;
        }
        const size_t plen = ((size_t)s_rx_asm[2] << 8) | (size_t)s_rx_asm[3];
        if (plen == 0U || plen > MT_PROTO_MAX) {
            memmove(s_rx_asm, s_rx_asm + 1U, s_rx_asm_len - 1U);
            s_rx_asm_len--;
            continue;
        }
        const size_t total = MT_FRAME_HDR + plen;
        if (s_rx_asm_len < total) {
            return;
        }
        if (!s_data_flowing) {
            s_data_flowing = true;
            ESP_LOGI(TAG, "Meshtastic serial data flowing");
            mt_notify_line("! meshtastic data flowing\n");
        }
        mt_lock();
        handle_from_radio(s_rx_asm + MT_FRAME_HDR, plen);
        mt_unlock();
        memmove(s_rx_asm, s_rx_asm + total, s_rx_asm_len - total);
        s_rx_asm_len -= total;
    }
}

void meshtastic_client_uart_rx(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0U) {
        return;
    }
    if (s_rx_asm_len + len > MT_RX_ASM_MAX) {
        ESP_LOGW(TAG, "RX asm overflow, dropping %u bytes", (unsigned)len);
        s_rx_asm_len = 0;
        return;
    }
    memcpy(s_rx_asm + s_rx_asm_len, data, len);
    s_rx_asm_len += len;
    consume_frames();
}

static void client_tick(int64_t now_us)
{
    if (!s_config_complete &&
        s_last_want_config_us > 0LL &&
        now_us - s_last_want_config_us >= (int64_t)MT_WANT_CONFIG_RETRY_MS * 1000LL) {
        (void)send_want_config(false);
    }
    if (s_stats_dirty) {
        s_stats_dirty = false;
        meshtastic_client_request_stats_notify();
    }
    if (s_stats_notify_pending && !s_stats_notify_busy) {
        const bool force = s_stats_notify_force;
        if (force || now_us - s_last_stats_notify_us >= MT_STATS_BLE_MIN_INTERVAL_US) {
            s_stats_notify_pending = false;
            s_stats_notify_force = false;
            if (force) {
                meshtastic_client_request_stats_notify_now();
            } else {
                meshtastic_client_request_stats_notify();
            }
        }
    }
}

static void client_task(void *arg)
{
    (void)arg;
    mt_notify_line("! meshtastic client started\n");
    (void)send_want_config(false);
    s_last_stats_notify_us = mt_now_us();

    for (;;) {
        client_tick(mt_now_us());
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

esp_err_t meshtastic_client_start(void)
{
    if (s_task != NULL) {
        return ESP_OK;
    }
    s_mtx = xSemaphoreCreateMutex();
    if (s_mtx == NULL) {
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreate(client_task, "mt_client", 6144, NULL, 5, &s_task) != pdPASS) {
        vSemaphoreDelete(s_mtx);
        s_mtx = NULL;
        return ESP_FAIL;
    }
    return ESP_OK;
}

static uint32_t parse_dest(const char *s)
{
    if (s == NULL) {
        return MT_BROADCAST;
    }
    while (*s == ' ' || *s == '\t') {
        s++;
    }
    if (strcmp(s, "broadcast") == 0 || strcmp(s, "all") == 0 || strcmp(s, "0") == 0) {
        return MT_BROADCAST;
    }
    char *end = NULL;
    const unsigned long v = strtoul(s, &end, 0);
    if (end == s) {
        return MT_BROADCAST;
    }
    return (uint32_t)v;
}

static void trim_inplace(char *s)
{
    if (s == NULL) {
        return;
    }
    char *start = s;
    while (*start == ' ' || *start == '\t') {
        start++;
    }
    if (start != s) {
        memmove(s, start, strlen(start) + 1U);
    }
    size_t n = strlen(s);
    while (n > 0U && (s[n - 1U] == ' ' || s[n - 1U] == '\t' || s[n - 1U] == '\r' || s[n - 1U] == '\n')) {
        s[--n] = '\0';
    }
}

/** Parse BLE `send=<dest>\n<text>`; never pass the command string to send_text_packet(). */
static bool parse_send_ble_cmd(char *buf, size_t len, uint32_t *dest_out, const char **text_out)
{
    if (buf == NULL || dest_out == NULL || text_out == NULL || len == 0U) {
        return false;
    }
    if (len >= 512U) {
        len = 511U;
    }
    buf[len] = '\0';
    trim_inplace(buf);

    if (strncmp(buf, "send=", 5) != 0) {
        return false;
    }

    char *rest = buf + 5;
    trim_inplace(rest);
    char *sep = strchr(rest, '\n');
    if (sep == NULL) {
        sep = strchr(rest, '\r');
    }
    if (sep == NULL) {
        char *lit = strstr(rest, "\\n");
        if (lit == NULL) {
            return false;
        }
        *lit = '\0';
        trim_inplace(rest);
        *text_out = lit + 2;
    } else {
        *sep = '\0';
        trim_inplace(rest);
        const char *text = sep + 1;
        if (*text == '\r') {
            text++;
        }
        if (*text == '\n') {
            text++;
        }
        *text_out = text;
    }

    trim_inplace((char *)*text_out);
    if ((*text_out)[0] == '\0') {
        return false;
    }
    if (strncmp(*text_out, "send=", 5) == 0) {
        return false;
    }
    *dest_out = parse_dest(rest);
    return true;
}

esp_err_t meshtastic_client_ble_write(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    char buf[512];
    if (len >= sizeof(buf)) {
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(buf, data, len);

    if (len >= 8U && strncmp(buf, "config=1", 8) == 0) {
        mt_lock();
        s_data_flowing = false;
        const esp_err_t err = send_want_config(true);
        mt_unlock();
        return err;
    }

    uint32_t dest = MT_BROADCAST;
    const char *text = NULL;
    if (!parse_send_ble_cmd(buf, len, &dest, &text)) {
        return ESP_ERR_NOT_FOUND;
    }

    mt_lock();
    const esp_err_t err = send_text_packet(dest, text);
    mt_unlock();
    if (err == ESP_OK) {
        s_stats_dirty = true;
    }
    return err;
}

esp_err_t meshtastic_client_stats_write(const char *cmd, size_t len)
{
    if (cmd == NULL || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (len >= 7U && strncmp(cmd, "stats=1", 7) == 0 &&
        (len == 7U || cmd[7] == '\0' || cmd[7] == '\n' || cmd[7] == '\r')) {
        meshtastic_client_request_stats_notify_now();
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

static size_t ble_json_pick_nodes(size_t *out_idx, size_t out_cap)
{
    size_t n = 0;
    bool my_included = false;

    for (size_t pick = 0; pick < MT_NODE_MAX && n < out_cap; pick++) {
        size_t best_i = MT_NODE_MAX;
        int64_t best_us = INT64_MIN;
        for (size_t i = 0; i < MT_NODE_MAX; i++) {
            if (!s_nodes[i].used) {
                continue;
            }
            bool already = false;
            for (size_t j = 0; j < n; j++) {
                if (out_idx[j] == i) {
                    already = true;
                    break;
                }
            }
            if (already) {
                continue;
            }
            if (s_nodes[i].last_heard_us > best_us) {
                best_us = s_nodes[i].last_heard_us;
                best_i = i;
            }
        }
        if (best_i >= MT_NODE_MAX) {
            break;
        }
        out_idx[n++] = best_i;
        if (s_have_my_num && s_nodes[best_i].num == s_my_num) {
            my_included = true;
        }
    }

    if (s_have_my_num && !my_included) {
        for (size_t i = 0; i < MT_NODE_MAX; i++) {
            if (s_nodes[i].used && s_nodes[i].num == s_my_num) {
                if (n < out_cap) {
                    out_idx[n++] = i;
                } else if (n > 0U) {
                    out_idx[n - 1U] = i;
                }
                break;
            }
        }
    }
    return n;
}

static size_t format_json_locked(char *out, size_t out_cap)
{
    if (out == NULL || out_cap < 64U) {
        return 0;
    }
    const int64_t now_us = mt_now_us();
    size_t node_idx[MT_BLE_JSON_NODE_MAX];
    const size_t node_count = ble_json_pick_nodes(node_idx, MT_BLE_JSON_NODE_MAX);
    size_t pos = 0;
    int n;
    if (s_have_my_num) {
        n = snprintf(out, out_cap,
                     "{\"connected\":true,\"config_ok\":%s,\"my_num\":%lu,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu,\"gps_rx\":%lu,\"gps_api_rx\":%lu,\"nodes\":[",
                     s_config_complete ? "true" : "false", (unsigned long)s_my_num,
                     (unsigned long)s_tx_ok, (unsigned long)s_tx_fail, (unsigned long)s_rx_count,
                     (unsigned long)s_gps_rx, (unsigned long)s_gps_api_rx);
    } else {
        n = snprintf(out, out_cap,
                     "{\"connected\":true,\"config_ok\":%s,\"my_num\":null,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu,\"gps_rx\":%lu,\"gps_api_rx\":%lu,\"nodes\":[",
                     s_config_complete ? "true" : "false", (unsigned long)s_tx_ok,
                     (unsigned long)s_tx_fail, (unsigned long)s_rx_count, (unsigned long)s_gps_rx,
                     (unsigned long)s_gps_api_rx);
    }
    if (n < 0 || (size_t)n >= out_cap) {
        return 0;
    }
    pos = (size_t)n;

    bool first = true;
    for (size_t ni = 0; ni < node_count; ni++) {
        const mt_node_t *node = &s_nodes[node_idx[ni]];
        if (!node->used) {
            continue;
        }
        const int64_t age_ms = (now_us - node->last_heard_us) / 1000LL;
        n = snprintf(out + pos, out_cap - pos, "%s{\"num\":%lu", first ? "" : ",",
                     (unsigned long)node->num);
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        if (node->has_pos) {
            n = snprintf(out + pos, out_cap - pos,
                         ",\"last_ms\":%lld,\"lat\":%.6f,\"lon\":%.6f,\"alt_m\":%d,\"speed_mps\":%.2f,\"heading_deg\":%.1f",
                         (long long)age_ms, node->lat_deg, node->lon_deg, (int)node->alt_m,
                         (double)node->speed_mps, (double)node->heading_deg);
        } else {
            n = snprintf(out + pos, out_cap - pos, ",\"last_ms\":%lld", (long long)age_ms);
        }
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        if (node->has_gps_update) {
            n = snprintf(out + pos, out_cap - pos,
                         ",\"has_gps_update\":true,\"gps_has_lock\":%s,\"fix_quality\":%lu,\"fix_type\":%lu,"
                         "\"sats_in_view\":%lu,\"seq_number\":%lu,\"time_sec\":%lu,\"timestamp_sec\":%lu",
                         node->gps_has_lock ? "true" : "false", (unsigned long)node->fix_quality,
                         (unsigned long)node->fix_type, (unsigned long)node->sats_in_view,
                         (unsigned long)node->seq_number, (unsigned long)node->time_sec,
                         (unsigned long)node->timestamp_sec);
            if (n < 0 || (size_t)n >= out_cap - pos) {
                return 0;
            }
            pos += (size_t)n;
        }
        if (pos + 2U >= out_cap) {
            return 0;
        }
        out[pos++] = '}';
        first = false;
    }

    if (pos + 14U >= out_cap) {
        return 0;
    }
    memcpy(out + pos, "],\"rx_msgs\":[", 14);
    pos += 14;

    if (s_rx_msg_count == 0U) {
        if (pos + 2U >= out_cap) {
            return 0;
        }
        out[pos++] = ']';
        out[pos++] = '}';
        out[pos] = '\0';
        return pos;
    }

    /* One truncated RX msg max — keeps BLE JSON under MTU. */
    const mt_rx_msg_t *m = &s_rx_msgs[s_rx_msg_count - 1U];
    const int64_t age_ms = (now_us - m->received_us) / 1000LL;
    n = snprintf(out + pos, out_cap - pos, "{\"from\":%lu,\"from_name\":\"", (unsigned long)m->from);
    if (n < 0 || (size_t)n >= out_cap - pos) {
        return 0;
    }
    pos += (size_t)n;
    if (!json_escape_append_trunc(out, out_cap, &pos, m->from_name, MT_NAME_MAX)) {
        return 0;
    }
    n = snprintf(out + pos, out_cap - pos, "\",\"text\":\"");
    if (n < 0 || (size_t)n >= out_cap - pos) {
        return 0;
    }
    pos += (size_t)n;
    if (!json_escape_append_trunc(out, out_cap, &pos, m->text, MT_BLE_JSON_TEXT_MAX)) {
        return 0;
    }
    n = snprintf(out + pos, out_cap - pos, "\",\"last_ms\":%lld}", (long long)age_ms);
    if (n < 0 || (size_t)n >= out_cap - pos) {
        return 0;
    }
    pos += (size_t)n;

    if (pos + 2U >= out_cap) {
        return 0;
    }
    out[pos++] = ']';
    out[pos++] = '}';
    out[pos] = '\0';
    return pos;
}

size_t meshtastic_client_format_json(char *out, size_t out_cap)
{
    mt_lock();
    const size_t n = format_json_locked(out, out_cap);
    mt_unlock();
    return n;
}

static void stats_notify_send(bool force)
{
    char json[4096];
    size_t n = 0;
    const int64_t now_us = mt_now_us();

    mt_lock();
    if (s_stats_notify_busy) {
        s_stats_notify_pending = true;
        if (force) {
            s_stats_notify_force = true;
        }
        mt_unlock();
        return;
    }
    if (!force && (now_us - s_last_stats_notify_us) < MT_STATS_BLE_MIN_INTERVAL_US) {
        s_stats_notify_pending = true;
        mt_unlock();
        return;
    }
    s_stats_notify_busy = true;
    n = format_json_locked(json, sizeof(json));
    mt_unlock();

    if (n > 0U) {
        ble_sen0140_meshtastic_stats_notify((const uint8_t *)json, n);
    }

    mt_lock();
    s_stats_notify_busy = false;
    s_last_stats_notify_us = now_us;
    mt_unlock();
}

void meshtastic_client_request_stats_notify(void)
{
    stats_notify_send(false);
}

void meshtastic_client_request_stats_notify_now(void)
{
    stats_notify_send(true);
}

bool meshtastic_client_get_my_num(uint32_t *out_num)
{
    if (!s_have_my_num || out_num == NULL) {
        return false;
    }
    *out_num = s_my_num;
    return true;
}

bool meshtastic_client_is_config_ready(void)
{
    return s_config_complete;
}

#else

esp_err_t meshtastic_client_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void meshtastic_client_uart_rx(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
}

esp_err_t meshtastic_client_ble_write(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t meshtastic_client_stats_write(const char *cmd, size_t len)
{
    (void)cmd;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

size_t meshtastic_client_format_json(char *out, size_t out_cap)
{
    (void)out;
    (void)out_cap;
    return 0;
}

void meshtastic_client_request_stats_notify(void)
{
}

void meshtastic_client_request_stats_notify_now(void)
{
}

bool meshtastic_client_get_my_num(uint32_t *out_num)
{
    (void)out_num;
    return false;
}

bool meshtastic_client_is_config_ready(void)
{
    return false;
}

esp_err_t meshtastic_client_broadcast_bytes(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_MESHTASTIC_ENABLE */
