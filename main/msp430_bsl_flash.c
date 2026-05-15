/*
 * MSP430 FR BSL UART programming (SLAU550), CRC per python-msp430-tools bsl5.
 */
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "ble_sen0140.h"
#include "msp430_bsl_invoke.h"
#include "msp430_bsl_flash.h"
#include "msp430_uart_rx.h"

static const char *TAG = "msp430_bsl_flash";

#define BSL_CORE_MAX    280
#define BSL_PKT_MAX     (5 + BSL_CORE_MAX)
#define BSL_CHUNK       240
#define UART_RD_SHORT   pdMS_TO_TICKS(400)
#define UART_RD_LONG    pdMS_TO_TICKS(5000)

static uint16_t crc16_update(uint16_t crc, uint8_t byte)
{
    unsigned x = ((crc >> 8) ^ byte) & 0xff;
    x ^= x >> 4;
    return (uint16_t)(((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & 0xffff);
}

static uint16_t crc16_buf(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xffff;
    for (size_t i = 0; i < len; i++) {
        crc = crc16_update(crc, data[i]);
    }
    return crc;
}

static void prog_status(const char *msg)
{
    ESP_LOGI(TAG, "%s", msg);
    ble_sen0140_prog_status_notify(msg);
}

static esp_err_t bsl_wait_ack(void)
{
    uint8_t ack = 0;
    int n = uart_read_bytes(MSP430_BRIDGE_UART_NUM, &ack, 1, UART_RD_LONG);
    if (n != 1) {
        ESP_LOGE(TAG, "BSL ack timeout");
        return ESP_ERR_TIMEOUT;
    }
    if (ack == 0x00) {
        return ESP_OK;
    }
    /* SLAU550 §4.1.5.3: FR5xx/FR6xx mass-erase path may ACK with 0x00 or 0xFF */
    if (ack == 0xff) {
        ESP_LOGD(TAG, "BSL ack 0xFF (allowed on FR BSL)");
        return ESP_OK;
    }
    ESP_LOGE(TAG, "BSL ack error 0x%02x", ack);
    return ESP_FAIL;
}

/** PI response packet after ACK (optional for some cmds). */
static esp_err_t bsl_recv_pi_response(uint8_t *body, size_t body_max, size_t *body_len)
{
    uint8_t hdr[3];
    int n = uart_read_bytes(MSP430_BRIDGE_UART_NUM, hdr, 3, UART_RD_LONG);
    if (n != 3) {
        return ESP_ERR_TIMEOUT;
    }
    if (hdr[0] != 0x80) {
        return ESP_FAIL;
    }
    uint16_t L = (uint16_t)(hdr[1] | (hdr[2] << 8));
    if (L > body_max) {
        return ESP_ERR_INVALID_SIZE;
    }
    n = uart_read_bytes(MSP430_BRIDGE_UART_NUM, body, L, UART_RD_LONG);
    if (n != (int)L) {
        return ESP_ERR_TIMEOUT;
    }
    uint8_t crcb[2];
    n = uart_read_bytes(MSP430_BRIDGE_UART_NUM, crcb, 2, UART_RD_SHORT);
    if (n != 2) {
        return ESP_ERR_TIMEOUT;
    }
    uint16_t rx_crc = (uint16_t)(crcb[0] | (crcb[1] << 8));
    uint16_t ex_crc = crc16_buf(body, L);
    if (rx_crc != ex_crc) {
        ESP_LOGW(TAG, "BSL resp CRC mismatch rx=%04x ex=%04x", rx_crc, ex_crc);
        return ESP_ERR_INVALID_CRC;
    }
    *body_len = L;
    return ESP_OK;
}

static size_t build_pi_packet(uint8_t *out, size_t out_max, const uint8_t *core, size_t core_len)
{
    if (core_len > BSL_CORE_MAX || (5 + core_len) > out_max) {
        return 0;
    }
    out[0] = 0x80;
    out[1] = (uint8_t)(core_len & 0xff);
    out[2] = (uint8_t)((core_len >> 8) & 0xff);
    memcpy(out + 3, core, core_len);
    uint16_t crc = crc16_buf(core, core_len);
    out[3 + core_len] = (uint8_t)(crc & 0xff);
    out[3 + core_len + 1] = (uint8_t)((crc >> 8) & 0xff);
    return 5 + core_len;
}

/** Send PI packet and wait for single-byte ACK only (no core response). */
static esp_err_t bsl_pi_tx(const uint8_t *core, size_t core_len)
{
    uint8_t pkt[BSL_PKT_MAX];
    size_t plen = build_pi_packet(pkt, sizeof(pkt), core, core_len);
    if (plen == 0) {
        return ESP_ERR_INVALID_SIZE;
    }
    int w = uart_write_bytes(MSP430_BRIDGE_UART_NUM, pkt, (int)plen);
    if (w != (int)plen) {
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(MSP430_BRIDGE_UART_NUM, pdMS_TO_TICKS(500));
    vTaskDelay(pdMS_TO_TICKS(3));
    return bsl_wait_ack();
}

/** ACK + full PI response body (CRC-checked). */
static esp_err_t bsl_pi_tx_rx(const uint8_t *core, size_t core_len, uint8_t *body, size_t body_max, size_t *body_len)
{
    esp_err_t err = bsl_pi_tx(core, core_len);
    if (err != ESP_OK) {
        return err;
    }
    return bsl_recv_pi_response(body, body_max, body_len);
}

static esp_err_t bsl_send_core(const uint8_t *core, size_t core_len, bool read_response)
{
    if (!read_response) {
        return bsl_pi_tx(core, core_len);
    }

    uint8_t body[260];
    size_t bl = 0;
    esp_err_t err = bsl_pi_tx_rx(core, core_len, body, sizeof(body), &bl);
    if (err != ESP_OK) {
        return err;
    }
    /* Expect CMD 0x3B + MSG (Table 4-7) when present */
    if (bl >= 2 && body[0] == 0x3b) {
        if (body[1] != 0x00) {
            ESP_LOGE(TAG, "BSL core msg 0x%02x", body[1]);
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

/**
 * After RX Password unlock: TX BSL Version (SLAU550 §4.1.5.7) + TX Data Block read of vector/password
 * region 0xFFE0–0xFFFF. Best-effort; failures do not abort programming.
 */
static void msp430_bsl_report_unlocked_info(void)
{
    uint8_t body[260];
    size_t bl = 0;

    prog_status("MSP430: querying BSL ROM version…");
    uint8_t core_ver[1] = {0x19};
    esp_err_t err = bsl_pi_tx_rx(core_ver, sizeof(core_ver), body, sizeof(body), &bl);
    if (err != ESP_OK || bl < 5 || body[0] != 0x3a) {
        char msg[96];
        snprintf(msg, sizeof(msg), "MSP430: BSL version unavailable (%s)", esp_err_to_name(err));
        prog_status(msg);
    } else {
        uint8_t vendor = body[1];
        uint8_t ci = body[2];
        uint8_t api = body[3];
        uint8_t pi = body[4];

        const char *api_k = "?";
        if (api <= 0x0f) {
            api_k = "Flash API";
        } else if (api >= 0x30 && api <= 0x3f) {
            api_k = "FRAM API";
        } else if (api >= 0x80 && api <= 0x8f) {
            api_k = "minimal BSL";
        }

        const char *pi_k = "?";
        if (pi >= 0x70 && pi <= 0x8f) {
            pi_k = "eUSCI UART";
        } else if (pi >= 0x50 && pi <= 0x6f) {
            pi_k = "USCI UART";
        } else if (pi >= 0xb0 && pi <= 0xbf) {
            pi_k = "eUSCI UART+I2C";
        }

        char msg[180];
        snprintf(msg, sizeof(msg), "MSP430: BSL ROM %02X.%02X.%02X.%02X vendor=%u — %s / %s", vendor, ci, api,
                 pi, vendor, api_k, pi_k);
        prog_status(msg);
    }

    prog_status("MSP430: reading password vectors 0xFFE0–0xFFFF…");
    const uint32_t vaddr = 0xffe0;
    const uint16_t vlen = 32;
    uint8_t core_rd[6] = {
        0x18,
        (uint8_t)(vaddr & 0xff),
        (uint8_t)((vaddr >> 8) & 0xff),
        (uint8_t)((vaddr >> 16) & 0xff),
        (uint8_t)(vlen & 0xff),
        (uint8_t)((vlen >> 8) & 0xff),
    };
    err = bsl_pi_tx_rx(core_rd, sizeof(core_rd), body, sizeof(body), &bl);
    if (err != ESP_OK || bl < 1U + (size_t)vlen || body[0] != 0x3a) {
        char fail[96];
        snprintf(fail, sizeof(fail), "MSP430: vector read failed (%s)", esp_err_to_name(err));
        prog_status(fail);
        return;
    }

    const uint8_t *vec = body + 1;
    unsigned nonff = 0;
    for (unsigned i = 0; i < vlen; i++) {
        if (vec[i] != 0xff) {
            nonff++;
        }
    }

    char line[180];
    snprintf(line, sizeof(line), "MSP430: vectors %u non-0xFF / 32 B (BSL password image)", nonff);
    prog_status(line);

    /* Two notify lines: 16 bytes hex each (fits BLE cap) */
    snprintf(line, sizeof(line),
             "MSP430: FFE0 %02X%02X%02X%02X %02X%02X%02X%02X %02X%02X%02X%02X %02X%02X%02X%02X", vec[0],
             vec[1], vec[2], vec[3], vec[4], vec[5], vec[6], vec[7], vec[8], vec[9], vec[10], vec[11],
             vec[12], vec[13], vec[14], vec[15]);
    prog_status(line);
    snprintf(line, sizeof(line),
             "MSP430: FFF0 %02X%02X%02X%02X %02X%02X%02X%02X %02X%02X%02X%02X %02X%02X%02X%02X", vec[16],
             vec[17], vec[18], vec[19], vec[20], vec[21], vec[22], vec[23], vec[24], vec[25], vec[26],
             vec[27], vec[28], vec[29], vec[30], vec[31]);
    prog_status(line);
}

/**
 * FR5xx/FR6xx UART BSL: python-msp430-tools and TI collateral use a *wrong* RX password
 * (30×0xFF + 2×0x00) to trigger silicon mass erase — not core cmd 0x15. Sending 0x15 first
 * often yields no ACK over UART (host sees ESP_ERR_TIMEOUT) even though BSL is active.
 */
static esp_err_t bsl_mass_erase(void)
{
    uint8_t core[33];
    core[0] = 0x11;
    memset(core + 1, 0xff, 30);
    core[31] = 0;
    core[32] = 0;

    prog_status("BSL: mass erase (wrong-password trigger)…");
    esp_err_t err = bsl_send_core(core, sizeof(core), false);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mass erase trigger: %s — continuing (matches python-msp430-tools)", esp_err_to_name(err));
    }
    vTaskDelay(pdMS_TO_TICKS(500));
    msp430_uart_flush_rx();
    prog_status("BSL: mass erase ~5.5 s wait…");
    vTaskDelay(pdMS_TO_TICKS(5500));
    prog_status("BSL: mass erase wait done");
    return ESP_OK;
}

/**
 * SLAU550: after incorrect RX password / mass erase, FR BSL may not respond normally — host must
 * "initialize the communication with BSL again." Re-run RST/TEST entry, wait for ROM UART (TLV BSL
 * can need ~300 ms), drain RX.
 */
static void msp430_bsl_resync_after_mass_erase(void)
{
    prog_status("MSP430: BSL re-entry after erase (re-init link)…");
    vTaskDelay(pdMS_TO_TICKS(400));
    msp430_uart_flush_rx();
    if (msp430_bsl_invoke_ready()) {
        (void)msp430_bsl_invoke_hardware();
    }
    vTaskDelay(pdMS_TO_TICKS(900));
    msp430_uart_flush_rx();
}

static esp_err_t bsl_rx_password_ff(void)
{
    uint8_t core[1 + 32];
    core[0] = 0x11;
    memset(core + 1, 0xff, 32);
    return bsl_send_core(core, sizeof(core), true);
}

/** After mass erase, retry default password with fresh BSL entry (matches DrizzlingBytes-style loops). */
static esp_err_t bsl_rx_password_ff_retries(bool after_mass_erase)
{
    const unsigned max_tries = after_mass_erase ? 4U : 1U;
    esp_err_t last = ESP_ERR_TIMEOUT;

    for (unsigned t = 1; t <= max_tries; t++) {
        char m[80];
        snprintf(m, sizeof(m), "MSP430: RX password try %u/%u…", t, max_tries);
        prog_status(m);
        msp430_uart_flush_rx();
        last = bsl_rx_password_ff();
        if (last == ESP_OK) {
            return ESP_OK;
        }
        ESP_LOGW(TAG, "RX password try %u/%u: %s", t, max_tries, esp_err_to_name(last));
        if (t < max_tries) {
            prog_status("MSP430: re-invoke BSL, then retry password…");
            vTaskDelay(pdMS_TO_TICKS(400));
            msp430_uart_flush_rx();
            if (msp430_bsl_invoke_ready()) {
                (void)msp430_bsl_invoke_hardware();
            }
            vTaskDelay(pdMS_TO_TICKS(900));
            msp430_uart_flush_rx();
        }
    }
    return last;
}

static esp_err_t bsl_rx_data_block(uint32_t addr, const uint8_t *data, size_t len)
{
    if (len == 0 || len > BSL_CHUNK) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t core[4 + BSL_CHUNK];
    core[0] = 0x10;
    core[1] = (uint8_t)(addr & 0xff);
    core[2] = (uint8_t)((addr >> 8) & 0xff);
    core[3] = (uint8_t)((addr >> 16) & 0xff);
    memcpy(core + 4, data, len);
    return bsl_send_core(core, 4 + len, true);
}

static void trim_line_inplace(char *s)
{
    if (!s) {
        return;
    }
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == '\r' || s[n - 1] == '\n' || isspace((unsigned char)s[n - 1]))) {
        s[--n] = '\0';
    }
    char *p = s;
    while (*p && isspace((unsigned char)*p)) {
        p++;
    }
    if (p != s) {
        memmove(s, p, strlen(p) + 1);
    }
}

static esp_err_t append_hex_line(uint8_t **acc, size_t *acc_len, size_t *acc_cap, const char *line)
{
    while (*line) {
        while (*line && isspace((unsigned char)*line)) {
            line++;
        }
        if (!line[0] || !line[1]) {
            break;
        }
        if (!isxdigit((unsigned char)line[0]) || !isxdigit((unsigned char)line[1])) {
            return ESP_ERR_INVALID_ARG;
        }
        char hx[3] = {line[0], line[1], '\0'};
        unsigned long v = strtoul(hx, NULL, 16);
        if (*acc_len + 1 > *acc_cap) {
            size_t ncap = *acc_cap ? (*acc_cap * 2) : 512;
            if (ncap > 131072) {
                return ESP_ERR_NO_MEM;
            }
            uint8_t *p = realloc(*acc, ncap);
            if (!p) {
                return ESP_ERR_NO_MEM;
            }
            *acc = p;
            *acc_cap = ncap;
        }
        (*acc)[(*acc_len)++] = (uint8_t)v;
        line += 2;
    }
    return ESP_OK;
}

static esp_err_t flush_segment(uint32_t base, uint8_t *acc, size_t acc_len)
{
    if (acc_len == 0) {
        return ESP_OK;
    }
    char seg_intro[80];
    snprintf(seg_intro, sizeof(seg_intro), "BSL: segment %u B → MSP430 from 0x%05lX", (unsigned)acc_len,
             (unsigned long)base);
    prog_status(seg_intro);

    size_t off = 0;
    unsigned n_written = 0;
    while (off < acc_len) {
        size_t chunk = acc_len - off;
        if (chunk > BSL_CHUNK) {
            chunk = BSL_CHUNK;
        }
        esp_err_t err = bsl_rx_data_block(base + (uint32_t)off, acc + off, chunk);
        if (err != ESP_OK) {
            return err;
        }
        off += chunk;
        n_written++;
        if ((n_written % 2U) == 0U || off == acc_len) {
            unsigned pct = acc_len ? (unsigned)((100ULL * off) / acc_len) : 100U;
            char msg[88];
            snprintf(msg, sizeof(msg), "BSL: wrote %u / %u B in segment (%u%%) last @0x%05lX", (unsigned)off,
                     (unsigned)acc_len, pct, (unsigned long)(base + off - 1));
            prog_status(msg);
        }
    }
    return ESP_OK;
}

esp_err_t msp430_bsl_flash_ti_txt(uint8_t *txt, size_t txt_len, bool mass_erase_first)
{
    if (!txt || txt_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Caller owns buffer sized txt_len+1 with txt[txt_len]==0; strtok_r mutates contents. */
    char *doc = (char *)txt;
    if (doc[txt_len] != '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    if (strchr(doc, '@') == NULL && strchr(doc, 'q') == NULL) {
        if (txt_len > 1 && txt[0] == ':') {
            prog_status("MSP430: Intel HEX not supported — export TI-TXT from CCS");
            return ESP_ERR_NOT_SUPPORTED;
        }
    }

    esp_err_t err = ESP_OK;
    uint8_t *acc = NULL;
    size_t acc_len = 0;
    size_t acc_cap = 0;

    prog_status("MSP430: BSL session (9600 8E1)…");
    msp430_uart_bridge_set_enabled(false);
    vTaskDelay(pdMS_TO_TICKS(50));
    msp430_uart_flush_rx();
    err = msp430_uart_apply_config(9600, UART_PARITY_EVEN);
    if (err != ESP_OK) {
        goto restore_uart;
    }
    vTaskDelay(pdMS_TO_TICKS(30));

    if (msp430_bsl_invoke_ready()) {
        prog_status("MSP430: BSL GPIO entry…");
        (void)msp430_bsl_invoke_hardware();
    }
    /* Allow BSL ROM to bring up eUSCI after reset (FR6043 uses A3 per SLAU550). */
    vTaskDelay(pdMS_TO_TICKS(500));
    msp430_uart_flush_rx();

    if (mass_erase_first) {
        err = bsl_mass_erase();
        if (err != ESP_OK) {
            goto restore_uart;
        }
        msp430_bsl_resync_after_mass_erase();
    }

    err = bsl_rx_password_ff_retries(mass_erase_first);
    if (err != ESP_OK) {
        prog_status("MSP430: password failed — BSL disabled, bad wiring, or erase incomplete");
        goto restore_uart;
    }

    msp430_bsl_report_unlocked_info();

    size_t doc_line_total = 1;
    for (char *pp = doc; *pp; pp++) {
        if (*pp == '\n') {
            doc_line_total++;
        }
    }

    prog_status("MSP430: parsing TI-TXT…");
    uint32_t seg_base = 0;
    bool have_seg = false;
    size_t line_ix = 0;

    char *save = NULL;
    for (char *line = strtok_r(doc, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save)) {
        line_ix++;
        if ((line_ix % 40U) == 0U) {
            char ls[64];
            snprintf(ls, sizeof(ls), "MSP430: TI-TXT line ~%u / %u", (unsigned)line_ix, (unsigned)doc_line_total);
            prog_status(ls);
        }

        trim_line_inplace(line);
        if (line[0] == '\0') {
            continue;
        }
        if (line[0] == '@') {
            if (have_seg) {
                err = flush_segment(seg_base, acc, acc_len);
                free(acc);
                acc = NULL;
                acc_len = acc_cap = 0;
                if (err != ESP_OK) {
                    goto restore_uart;
                }
            }
            unsigned long a = strtoul(line + 1, NULL, 16);
            seg_base = (uint32_t)a;
            have_seg = true;
            continue;
        }
        if (line[0] == 'q' || line[0] == 'Q') {
            break;
        }
        if (!have_seg) {
            err = ESP_ERR_INVALID_ARG;
            goto restore_uart;
        }
        err = append_hex_line(&acc, &acc_len, &acc_cap, line);
        if (err != ESP_OK) {
            goto restore_uart;
        }
    }

    if (have_seg && err == ESP_OK) {
        err = flush_segment(seg_base, acc, acc_len);
    }

restore_uart:
    free(acc);
    (void)msp430_uart_apply_config(115200, UART_PARITY_DISABLE);
    msp430_uart_flush_rx();
    msp430_uart_bridge_set_enabled(true);

    if (err == ESP_OK) {
        prog_status("MSP430: programming finished OK");
    } else {
        char msg[72];
        snprintf(msg, sizeof(msg), "MSP430: failed (%s)", esp_err_to_name(err));
        prog_status(msg);
    }
    return err;
}
