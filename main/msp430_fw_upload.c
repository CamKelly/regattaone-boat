#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "ble_sen0140.h"
#include "msp430_bsl_flash.h"
#include "msp430_fw_upload.h"

/** TI-TXT upload buffer cap (single malloc before BSL flash). */
#define MSP430_FW_UPLOAD_MAX (200 * 1024)

static uint8_t *s_fw_buf;
static uint32_t s_fw_expect;
static uint32_t s_fw_got;

typedef struct {
    uint8_t *p;
    size_t len;
    bool mass;
} fw_flash_ctx_t;

static void fw_flash_task(void *arg)
{
    fw_flash_ctx_t *ctx = arg;
    if (ctx && ctx->p && ctx->len > 0) {
        (void)msp430_bsl_flash_ti_txt(ctx->p, ctx->len, ctx->mass);
        free(ctx->p);
    }
    free(ctx);
    vTaskDelete(NULL);
}

void msp430_fw_upload_abort(void)
{
    free(s_fw_buf);
    s_fw_buf = NULL;
    s_fw_expect = 0;
    s_fw_got = 0;
}

esp_err_t msp430_fw_upload_ble_packet(const uint8_t *data, uint16_t len)
{
    if (!data || len < 1) {
        return ESP_ERR_INVALID_ARG;
    }

#if !CONFIG_REGATTAONE_MSP430_ENABLE
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
#else

    switch (data[0]) {
    case 0x04:
        msp430_fw_upload_abort();
        ble_sen0140_prog_status_notify("MSP430 upload: aborted");
        return ESP_OK;

    case 0x01: {
        if (len != 5) {
            return ESP_ERR_INVALID_ARG;
        }
        uint32_t total = (uint32_t)data[1] | ((uint32_t)data[2] << 8) | ((uint32_t)data[3] << 16) |
                         ((uint32_t)data[4] << 24);
        if (total == 0 || total > MSP430_FW_UPLOAD_MAX) {
            return ESP_ERR_INVALID_SIZE;
        }
        msp430_fw_upload_abort();
        /* +1 for NUL so BSL parser can use strtok in-place without a second full-size copy */
        s_fw_buf = malloc((size_t)total + 1U);
        if (!s_fw_buf) {
            return ESP_ERR_NO_MEM;
        }
        s_fw_expect = total;
        s_fw_got = 0;
        char msg[72];
        snprintf(msg, sizeof(msg), "ESP32: ready — expecting %lu B from browser…", (unsigned long)total);
        ble_sen0140_prog_status_notify(msg);
        return ESP_OK;
    }

    case 0x02: {
        if (len < 3) {
            return ESP_ERR_INVALID_ARG;
        }
        uint16_t chunk_len = (uint16_t)(data[1] | (data[2] << 8));
        if ((uint16_t)(len - 3) != chunk_len) {
            return ESP_ERR_INVALID_ARG;
        }
        if (!s_fw_buf || s_fw_got + chunk_len > s_fw_expect) {
            return ESP_ERR_INVALID_STATE;
        }
        memcpy(s_fw_buf + s_fw_got, data + 3, chunk_len);
        uint32_t prev = s_fw_got;
        s_fw_got += chunk_len;
        uint32_t pct = s_fw_expect ? (uint32_t)((100ULL * s_fw_got) / s_fw_expect) : 0;
        bool crossed = (s_fw_got / 4096U) != (prev / 4096U);
        if (s_fw_got == s_fw_expect || crossed) {
            char msg[80];
            snprintf(msg, sizeof(msg), "ESP32: received %lu / %lu B (%lu%%)", (unsigned long)s_fw_got,
                     (unsigned long)s_fw_expect, (unsigned long)pct);
            ble_sen0140_prog_status_notify(msg);
        }
        return ESP_OK;
    }

    case 0x03: {
        bool mass = (len >= 2) && ((data[1] & 0x01) != 0);
        if (!s_fw_buf || s_fw_got != s_fw_expect || s_fw_expect == 0) {
            msp430_fw_upload_abort();
            ble_sen0140_prog_status_notify("MSP430 upload: incomplete");
            return ESP_ERR_INVALID_STATE;
        }

        fw_flash_ctx_t *ctx = calloc(1, sizeof(fw_flash_ctx_t));
        if (!ctx) {
            return ESP_ERR_NO_MEM;
        }
        ctx->p = s_fw_buf;
        ctx->len = s_fw_got;
        ctx->mass = mass;
        size_t nbytes = s_fw_got;
        s_fw_buf = NULL;
        s_fw_expect = 0;
        s_fw_got = 0;

        char start_msg[96];
        snprintf(start_msg, sizeof(start_msg),
                 mass ? "ESP32: image OK (%lu B) — BSL mass erase + program…" : "ESP32: image OK (%lu B) — BSL program…",
                 (unsigned long)nbytes);
        ble_sen0140_prog_status_notify(start_msg);

        ctx->p[nbytes] = '\0';

        BaseType_t ok = xTaskCreate(fw_flash_task, "msp430_fw", 16384, ctx, 5, NULL);
        if (ok != pdPASS) {
            free(ctx->p);
            free(ctx);
            return ESP_ERR_NO_MEM;
        }
        return ESP_OK;
    }

    default:
        return ESP_ERR_INVALID_ARG;
    }
#endif
}
