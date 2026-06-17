#include "meshtastic_client.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE

#include "ble_sen0140.h"
#include "meshtastic_uart.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "mt_client";

#define MT_BROADCAST 0xFFFFFFFFU
#define MT_TEXT_APP 1U
#define MT_NODE_MAX 48U
#define MT_RX_MSG_MAX 16U
#define MT_NAME_MAX 32U
#define MT_TEXT_MAX 240U
#define MT_JSON_TEXT_MAX 120U
#define MT_FRAME_HDR 4U
#define MT_FRAME_MAX 512U
#define MT_PROTO_MAX (MT_FRAME_MAX - MT_FRAME_HDR)
#define MT_RX_ASM_MAX 4096U
#define MT_HEARTBEAT_MS 15000

typedef struct {
    uint32_t num;
    char long_name[MT_NAME_MAX];
    char short_name[8];
    int64_t last_heard_us;
    bool has_pos;
    double lat_deg;
    double lon_deg;
    int32_t alt_m;
    float speed_mps;
    float heading_deg;
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
static bool s_rebooted;
static uint32_t s_my_num;
static bool s_have_my_num;

static mt_node_t s_nodes[MT_NODE_MAX];
static mt_rx_msg_t s_rx_msgs[MT_RX_MSG_MAX];
static size_t s_rx_msg_count;

static uint32_t s_tx_ok;
static uint32_t s_tx_fail;
static uint32_t s_rx_count;
static int64_t s_last_heartbeat_us;
static int64_t s_last_stats_notify_us;
static bool s_stats_dirty;

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

static esp_err_t send_want_config(void)
{
    s_want_config_id++;
    if (s_want_config_id == 0U) {
        s_want_config_id = 1U;
    }
    s_config_complete = false;
    uint8_t proto[16];
    size_t n = 0;
    proto[n++] = 0x18U;
    n += pb_encode_varint(proto + n, sizeof(proto) - n, s_want_config_id);
    ESP_LOGI(TAG, "want_config_id=%lu", (unsigned long)s_want_config_id);
    return uart_send_frame(proto, n);
}

static esp_err_t send_heartbeat(void)
{
    const uint8_t proto[] = {0x3AU, 0x00U};
    return uart_send_frame(proto, sizeof(proto));
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

static esp_err_t send_text_packet(uint32_t dest, const char *text)
{
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

    uint32_t portnum = 0;
    const uint8_t *payload = NULL;
    size_t payload_len = 0;
    if (!pb_extract_uint32(decoded, decoded_len, 1U, &portnum)) {
        return;
    }
    if (portnum != MT_TEXT_APP) {
        return;
    }
    if (!pb_extract_bytes(decoded, decoded_len, 2U, &payload, &payload_len) || payload_len == 0U) {
        return;
    }

    (void)pb_extract_fixed32(data, len, 2U, &to);
    s_rx_count++;

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
    if (node == NULL || data == NULL || len == 0U) {
        return;
    }

    int32_t lat_i = 0;
    int32_t lon_i = 0;
    int32_t alt_m = 0;
    uint32_t ground_speed = 0;
    uint32_t ground_track = 0;

    const bool have_lat = pb_extract_sfixed32(data, len, 1U, &lat_i);
    const bool have_lon = pb_extract_sfixed32(data, len, 2U, &lon_i);
    if (!have_lat || !have_lon) {
        return;
    }

    node->lat_deg = (double)lat_i / 10000000.0;
    node->lon_deg = (double)lon_i / 10000000.0;
    if (pb_extract_int32(data, len, 3U, &alt_m)) {
        node->alt_m = alt_m;
    }
    if (pb_extract_uint32(data, len, 15U, &ground_speed) && ground_speed > 0U) {
        node->speed_mps = (float)ground_speed / 1000.0f;
    }
    if (pb_extract_uint32(data, len, 16U, &ground_track)) {
        node->heading_deg = (float)ground_track / 100.0f;
    }
    node->has_pos = true;
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
                mt_notify_line("! config ready\n");
                s_stats_dirty = true;
            }
            continue;
        }
        if (field == 8U && wire == 0U) {
            uint64_t rb = 0;
            if (pb_read_varint(&b, &rb) && rb != 0U) {
                s_rebooted = true;
                s_config_complete = false;
                mt_notify_line("! companion rebooted\n");
                (void)send_want_config();
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
    if (!s_config_complete || s_rebooted) {
        static int64_t s_last_cfg_req_us;
        if (now_us - s_last_cfg_req_us > 3000000LL) {
            s_last_cfg_req_us = now_us;
            (void)send_want_config();
        }
    }
    if (now_us - s_last_heartbeat_us >= (int64_t)MT_HEARTBEAT_MS * 1000LL) {
        s_last_heartbeat_us = now_us;
        (void)send_heartbeat();
    }
    if (s_stats_dirty || now_us - s_last_stats_notify_us >= 1000000LL) {
        s_stats_dirty = false;
        s_last_stats_notify_us = now_us;
        meshtastic_client_request_stats_notify();
    }
}

static void client_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1000));
    mt_notify_line("! meshtastic client started\n");
    (void)send_want_config();
    s_last_heartbeat_us = mt_now_us();
    s_last_stats_notify_us = s_last_heartbeat_us;

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
    buf[len] = '\0';

    if (strncmp(buf, "config=1", 8) == 0) {
        mt_lock();
        const esp_err_t err = send_want_config();
        mt_unlock();
        return err;
    }
    if (strncmp(buf, "send=", 5) != 0) {
        return ESP_ERR_NOT_FOUND;
    }
    const char *rest = buf + 5;
    char *nl = strchr(rest, '\n');
    if (nl == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    *nl = '\0';
    const char *text = nl + 1;
    if (text[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    const uint32_t dest = parse_dest(rest);
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
    if (len >= 16 && strncmp(cmd, "stats=1", 7) == 0) {
        meshtastic_client_request_stats_notify();
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

static size_t format_json_locked(char *out, size_t out_cap)
{
    if (out == NULL || out_cap < 64U) {
        return 0;
    }
    const int64_t now_us = mt_now_us();
    size_t pos = 0;
    int n;
    if (s_have_my_num) {
        n = snprintf(out, out_cap,
                     "{\"connected\":true,\"config_ok\":%s,\"my_num\":%lu,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu,\"nodes\":[",
                     s_config_complete ? "true" : "false", (unsigned long)s_my_num,
                     (unsigned long)s_tx_ok, (unsigned long)s_tx_fail, (unsigned long)s_rx_count);
    } else {
        n = snprintf(out, out_cap,
                     "{\"connected\":true,\"config_ok\":%s,\"my_num\":null,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu,\"nodes\":[",
                     s_config_complete ? "true" : "false", (unsigned long)s_tx_ok,
                     (unsigned long)s_tx_fail, (unsigned long)s_rx_count);
    }
    if (n < 0 || (size_t)n >= out_cap) {
        return 0;
    }
    pos = (size_t)n;

    bool first = true;
    for (size_t i = 0; i < MT_NODE_MAX; i++) {
        const mt_node_t *node = &s_nodes[i];
        if (!node->used) {
            continue;
        }
        if (s_have_my_num && node->num == s_my_num) {
            continue;
        }
        const int64_t age_ms = (now_us - node->last_heard_us) / 1000LL;
        const char *name = node->long_name[0] != '\0' ? node->long_name : "";
        const char *short_n = node->short_name[0] != '\0' ? node->short_name : "";
        n = snprintf(out + pos, out_cap - pos, "%s{\"num\":%lu,\"name\":\"", first ? "" : ",",
                     (unsigned long)node->num);
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        if (!json_escape_append(out, out_cap, &pos, name, MT_NAME_MAX)) {
            return 0;
        }
        n = snprintf(out + pos, out_cap - pos, "\",\"short\":\"");
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        if (!json_escape_append(out, out_cap, &pos, short_n, 8)) {
            return 0;
        }
        if (node->has_pos) {
            n = snprintf(out + pos, out_cap - pos,
                         "\",\"last_ms\":%lld,\"lat\":%.6f,\"lon\":%.6f,\"alt_m\":%d,\"speed_mps\":%.2f,\"heading_deg\":%.1f}",
                         (long long)age_ms, node->lat_deg, node->lon_deg, (int)node->alt_m,
                         (double)node->speed_mps, (double)node->heading_deg);
        } else {
            n = snprintf(out + pos, out_cap - pos, "\",\"last_ms\":%lld}", (long long)age_ms);
        }
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        first = false;
    }

    if (pos + 14U >= out_cap) {
        return 0;
    }
    memcpy(out + pos, "],\"rx_msgs\":[", 14);
    pos += 14;

    first = true;
    for (size_t i = 0; i < s_rx_msg_count; i++) {
        const mt_rx_msg_t *m = &s_rx_msgs[i];
        const int64_t age_ms = (now_us - m->received_us) / 1000LL;
        n = snprintf(out + pos, out_cap - pos, "%s{\"from\":%lu,\"from_name\":\"", first ? "" : ",",
                     (unsigned long)m->from);
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        if (!json_escape_append(out, out_cap, &pos, m->from_name, MT_NAME_MAX)) {
            return 0;
        }
        n = snprintf(out + pos, out_cap - pos, "\",\"text\":\"");
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        if (!json_escape_append(out, out_cap, &pos, m->text, MT_JSON_TEXT_MAX)) {
            return 0;
        }
        n = snprintf(out + pos, out_cap - pos, "\",\"last_ms\":%lld}", (long long)age_ms);
        if (n < 0 || (size_t)n >= out_cap - pos) {
            return 0;
        }
        pos += (size_t)n;
        first = false;
    }

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

void meshtastic_client_request_stats_notify(void)
{
    char json[4096];
    const size_t n = meshtastic_client_format_json(json, sizeof(json));
    if (n > 0U) {
        ble_sen0140_meshtastic_stats_notify((const uint8_t *)json, n);
    }
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

#endif /* CONFIG_REGATTAONE_MESHTASTIC_ENABLE */
