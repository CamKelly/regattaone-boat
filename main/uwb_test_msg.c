#include "uwb_test_msg.h"

#include <stdio.h>
#include <string.h>

#include "ble_sen0140.h"
#include "dw3000_ranging.h"

#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "dwmac.h"
#include "dwproto.h"
#include "mac802154.h"
#include "ranging.h"

static const char *TAG = "uwb_test";

_Static_assert(DWMAC_PROTO_SHORT_LEN + UWB_TEST_MSG_MAX_TEXT <= DWMAC_RXBUF_LEN,
               "UWB test text exceeds short-frame RX buffer");

static void ui_notify(const uint8_t *data, size_t len)
{
    /* Console stream only — avoids duplicate Test-tab lines when Meshtastic RX
     * also carries structured $PREG* traffic. */
    ble_sen0140_console_line_notify(data, len);
}

static size_t json_escape(const char *in, size_t in_len, char *out, size_t out_cap)
{
    if (out == NULL || out_cap == 0U) {
        return 0U;
    }
    size_t o = 0U;
    for (size_t i = 0; i < in_len; i++) {
        const unsigned char c = (unsigned char)in[i];
        if (c < 0x20U || c == '"' || c == '\\') {
            if (o + 6U >= out_cap) {
                break;
            }
            out[o++] = '\\';
            if (c == '"') {
                out[o++] = '"';
            } else if (c == '\\') {
                out[o++] = '\\';
            } else if (c == '\n') {
                out[o++] = 'n';
            } else if (c == '\r') {
                out[o++] = 'r';
            } else if (c == '\t') {
                out[o++] = 't';
            } else {
                out[o++] = 'u';
                out[o++] = '0';
                out[o++] = '0';
                static const char hex[] = "0123456789abcdef";
                out[o++] = hex[(c >> 4) & 0x0fU];
                out[o++] = hex[c & 0x0fU];
            }
        } else {
            if (o + 1U >= out_cap) {
                break;
            }
            out[o++] = (char)c;
        }
    }
    out[o] = '\0';
    return o;
}

static void publish(uint16_t src, uint16_t dst, const char *text, size_t text_len, const char *dir)
{
    char escaped[UWB_TEST_MSG_MAX_TEXT * 6U + 1U];
    (void)json_escape(text, text_len, escaped, sizeof(escaped));
    char line[192];
    const int n = snprintf(line, sizeof(line),
                           "$PREGMSG,{\"src\":%u,\"dst\":%u,\"dir\":\"%s\",\"text\":\"%s\"}\n",
                           (unsigned)src, (unsigned)dst, dir, escaped);
    if (n > 0 && (size_t)n < sizeof(line)) {
        ui_notify((const uint8_t *)line, (size_t)n);
    }
}

esp_err_t uwb_test_msg_send(uint16_t dst, const char *text, size_t text_len)
{
    if (text == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    while (text_len > 0U && (text[text_len - 1U] == '\0' || text[text_len - 1U] == '\n' ||
                             text[text_len - 1U] == '\r')) {
        text_len--;
    }
    if (text_len == 0U || text_len > UWB_TEST_MSG_MAX_TEXT) {
        return ESP_ERR_INVALID_ARG;
    }
    if (twr_in_progress()) {
        return ESP_ERR_INVALID_STATE;
    }

    struct txbuf *tx = dwmac_txbuf_get();
    if (tx == NULL) {
        return ESP_ERR_NO_MEM;
    }
    void *out = dwprot_short_prepare(tx, text_len, UWB_TEST_MSG_FUNC, dst);
    memcpy(out, text, text_len);
    if (!dwmac_transmit(tx)) {
        ESP_LOGW(TAG, "TX test msg failed dst=0x%04X len=%u", (unsigned)dst, (unsigned)text_len);
        return ESP_FAIL;
    }
    /* dwmac_transmit returns at TX start; allow the frame onto the air. */
    vTaskDelay(pdMS_TO_TICKS(20));
    const uint16_t src = dw3000_ranging_self_addr();
    publish(src, dst, text, text_len, "tx");
    ESP_LOGI(TAG, "TX test msg src=0x%04X dst=0x%04X len=%u", (unsigned)src, (unsigned)dst,
             (unsigned)text_len);
    return ESP_OK;
}

bool uwb_test_msg_try_handle(const struct rxbuf *rx)
{
    if (rx == NULL || !dwprot_check_min_len(rx->buf, rx->len)) {
        return false;
    }
    if (dwprot_get_func(rx->buf) != UWB_TEST_MSG_FUNC) {
        return false;
    }
    const size_t plen = dwprot_get_payload_len(rx->buf, rx->len);
    if (plen == 0U || plen > UWB_TEST_MSG_MAX_TEXT) {
        ESP_LOGW(TAG, "RX test msg dropped: bad len %u", (unsigned)plen);
        return true;
    }
    const uint16_t src = (uint16_t)dwprot_get_src(rx->buf);
    const struct prot_short *ps = (const struct prot_short *)rx->buf;
    const uint16_t dst = ps->hdr.dst;
    const char *text = (const char *)dwprot_get_payload(rx->buf);
    publish(src, dst, text, plen, "rx");
    ESP_LOGI(TAG, "RX test msg src=0x%04X dst=0x%04X len=%u", (unsigned)src, (unsigned)dst,
             (unsigned)plen);
    return true;
}
