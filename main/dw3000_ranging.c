#include "dw3000_ranging.h"

#include "dw3000_config.h"
#include "device_type.h"
#include "mark_blink.h"

#include "sdkconfig.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "dw3000_hw.h"

#include "dwhw.h"
#include "dwmac.h"
#include "dwphy.h"
#include "dwproto.h"
#include "mac802154.h"
#include "ranging.h"

static const char *TAG = "dw3000_rng";

#define DW3000_RANGE_DEFAULT_TIMEOUT_MS 120U

static bool s_ready;
static SemaphoreHandle_t s_op_mtx;   /* serializes dw3000_range_to() callers */
static SemaphoreHandle_t s_done_sem; /* given by observer when a range settles */

static volatile uint16_t s_pending_addr;
static volatile bool s_pending_active;
static volatile uint16_t s_result_cm;
static volatile bool s_result_ok;

static dw3000_range_result_cb_t s_user_cb;

static uint16_t self_addr(void)
{
    return dw3000_config_get()->addr;
}

/**
 * App RX path: mark blinks first; boats drop TWR so they stay UWB-passive
 * (no poll replies). All other frames go to libdeca dwprot_rx_handler.
 */
static void app_rx_handler(const struct rxbuf *rx)
{
    if (mark_blink_try_handle(rx)) {
        return;
    }

    if (device_type_get() == DEVICE_TYPE_BOAT && rx != NULL && rx->len >= 2) {
        const uint16_t fc = *(const uint16_t *)rx->buf;
        if ((fc & MAC154_FC_TYPE_DATA) != 0 && dwprot_check_min_len(rx->buf, rx->len)) {
            const uint8_t func = dwprot_get_func(rx->buf);
            if ((func & DWMAC_PROTO_MSG_MASK) == TWR_MSG_GROUP) {
                return; /* boat: never TX a TWR response */
            }
        }
    }

    dwprot_rx_handler(rx);
}

/* libdeca observer: called from the dwmac worker task for every settled TWR
 * exchange, whether we initiated it or answered a peer's request. */
static void twr_observer(uint64_t src, uint64_t dst, uint16_t dist, uint16_t num)
{
    (void)num;

    const uint16_t me = self_addr();
    const uint16_t s = (uint16_t)src;
    const uint16_t d = (uint16_t)dst;
    const uint16_t peer = (s == me) ? d : s;

    const bool ok = (dist != TWR_FAILED_VALUE && dist != TWR_OK_VALUE);
    const uint16_t cm = ok ? dist : 0;

    if (ok) {
        ESP_LOGI(TAG, "range 0x%04X: %u cm", peer, cm);
    } else {
        ESP_LOGW(TAG, "range 0x%04X: failed", peer);
    }

    if (s_pending_active && peer == s_pending_addr) {
        s_result_cm = cm;
        s_result_ok = ok;
        s_pending_active = false;
        xSemaphoreGive(s_done_sem);
    }

    if (s_user_cb) {
        s_user_cb(peer, cm, ok);
    }
}

esp_err_t dw3000_ranging_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    if (s_op_mtx == NULL) {
        s_op_mtx = xSemaphoreCreateMutex();
    }
    if (s_done_sem == NULL) {
        s_done_sem = xSemaphoreCreateBinary();
    }
    if (s_op_mtx == NULL || s_done_sem == NULL) {
        return ESP_ERR_NO_MEM;
    }

    /* decadriver hardware bring-up */
    esp_err_t err = dw3000_hw_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "dw3000_hw_init: %s", esp_err_to_name(err));
        return err;
    }
    dw3000_hw_reset();

    if (dw3000_hw_init_interrupt() != 0) {
        ESP_LOGE(TAG, "dw3000_hw_init_interrupt failed");
        return ESP_FAIL;
    }

    /* libdeca stack bring-up (also starts the deferred-IRQ worker task) */
    if (!dwhw_init()) {
        ESP_LOGE(TAG, "dwhw_init failed");
        return ESP_FAIL;
    }
    if (!dwphy_config()) {
        ESP_LOGE(TAG, "dwphy_config failed");
        return ESP_FAIL;
    }
    dwphy_set_antenna_delay(dw3000_config_get()->antenna_delay);

    const dw3000_config_t *cfg = dw3000_config_get();
    if (!dwmac_init(cfg->panid, cfg->addr, app_rx_handler, NULL, NULL)) {
        ESP_LOGE(TAG, "dwmac_init failed");
        return ESP_FAIL;
    }
    dwmac_set_frame_filter();

    twr_init(cfg->twr_delay_us, true);
    twr_set_observer(twr_observer);

    /* Stay in RX so marks can answer TWR and boats can sniff blinks. */
    dwmac_set_rx_reenable(true);

    s_ready = true;
    ESP_LOGI(TAG, "ready: addr 0x%04X, pan 0x%04X, ant %u, proc %lu us",
             self_addr(), cfg->panid, (unsigned)cfg->antenna_delay, (unsigned long)cfg->twr_delay_us);
    return ESP_OK;
}

esp_err_t dw3000_ranging_apply_config(void)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const dw3000_config_t *cfg = dw3000_config_get();
    dwphy_set_antenna_delay(cfg->antenna_delay);
    if (!dwmac_set_pan_addr(cfg->panid, cfg->addr)) {
        return ESP_ERR_INVALID_ARG;
    }
    twr_init(cfg->twr_delay_us, true);
    ESP_LOGI(TAG, "applied config: addr 0x%04X pan 0x%04X ant %u twr %lu us", (unsigned)cfg->addr,
             (unsigned)cfg->panid, (unsigned)cfg->antenna_delay, (unsigned long)cfg->twr_delay_us);
    return ESP_OK;
}

uint16_t dw3000_ranging_self_addr(void)
{
    return self_addr();
}

uint16_t dw3000_ranging_panid(void)
{
    return dw3000_config_get()->panid;
}

void dw3000_ranging_set_callback(dw3000_range_result_cb_t cb)
{
    s_user_cb = cb;
}

esp_err_t dw3000_range_to(uint16_t peer_addr, uint16_t *dist_cm,
                          uint32_t timeout_ms)
{
    if (dist_cm == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    /* Boats are UWB-passive (blink sniff only). */
    if (device_type_get() == DEVICE_TYPE_BOAT) {
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (timeout_ms == 0) {
        timeout_ms = DW3000_RANGE_DEFAULT_TIMEOUT_MS;
    }

    if (xSemaphoreTake(s_op_mtx, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_INVALID_STATE; /* another range still running */
    }

    esp_err_t ret;

    /* clear any stale completion signal */
    xSemaphoreTake(s_done_sem, 0);
    s_pending_addr = peer_addr;
    s_result_ok = false;
    s_result_cm = 0;
    s_pending_active = true;

    if (!twr_start(peer_addr)) {
        s_pending_active = false;
        ESP_LOGW(TAG, "twr_start 0x%04X rejected", peer_addr);
        ret = ESP_ERR_INVALID_STATE;
        goto out;
    }

    if (xSemaphoreTake(s_done_sem, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        s_pending_active = false;
        twr_cancel();
        ret = ESP_ERR_TIMEOUT;
        goto out;
    }

    if (s_result_ok) {
        *dist_cm = s_result_cm;
        ret = ESP_OK;
    } else {
        ret = ESP_FAIL;
    }

out:
    xSemaphoreGive(s_op_mtx);
    return ret;
}
