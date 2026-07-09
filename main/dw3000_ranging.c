#include "dw3000_ranging.h"

#include "sdkconfig.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "dw3000_hw.h"

#include "dwhw.h"
#include "dwmac.h"
#include "dwphy.h"
#include "dwproto.h"
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
    return (uint16_t)CONFIG_DW3000_ADDR;
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
    dwphy_set_antenna_delay((uint16_t)CONFIG_DW3000_ANTENNA_DELAY);

    if (!dwmac_init((uint16_t)CONFIG_DW3000_PANID, self_addr(),
                    dwprot_rx_handler, NULL, NULL)) {
        ESP_LOGE(TAG, "dwmac_init failed");
        return ESP_FAIL;
    }
    dwmac_set_frame_filter();

    twr_init((uint32_t)CONFIG_DW3000_TWR_PROCESSING_DELAY_US, true);
    twr_set_observer(twr_observer);

    /* Stay in RX so we can answer ranging requests from other devices. */
    dwmac_set_rx_reenable(true);

    s_ready = true;
    ESP_LOGI(TAG, "ready: addr 0x%04X, pan 0x%04X, ant %d, proc %d us",
             self_addr(), (uint16_t)CONFIG_DW3000_PANID,
             (int)CONFIG_DW3000_ANTENNA_DELAY,
             (int)CONFIG_DW3000_TWR_PROCESSING_DELAY_US);
    return ESP_OK;
}

uint16_t dw3000_ranging_self_addr(void)
{
    return self_addr();
}

uint16_t dw3000_ranging_panid(void)
{
    return (uint16_t)CONFIG_DW3000_PANID;
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
