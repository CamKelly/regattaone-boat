#include "mark_blink.h"

#include "sdkconfig.h"

#if CONFIG_DW3000_RANGING_ENABLE

#include "device_type.h"
#include "dw3000_ranging.h"

#include "dwmac.h"
#include "dwproto.h"
#include "dwtime.h"
#include "mac802154.h"
#include "ranging.h"

#include "deca_device_api.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <string.h>

static const char *TAG = "mark_blink";

#ifndef CONFIG_MARK_BLINK_INTERVAL_MS
#define CONFIG_MARK_BLINK_INTERVAL_MS 1000
#endif
#ifndef CONFIG_MARK_BLINK_FIXED_DELAY_US
#define CONFIG_MARK_BLINK_FIXED_DELAY_US 5000
#endif

struct mark_blink_msg {
    uint8_t role;            /**< 'P' or 'S' */
    uint32_t seq;            /**< Port-owned; Starboard echoes */
    uint16_t fixed_delay_us; /**< Starboard TX delay after Port RX ToA */
} __attribute__((packed));

static uint32_t s_port_seq;
static bool s_started;

/* Boat pairing state for matching Port+Starboard of the same seq. */
static bool s_have_port_half;
static uint32_t s_port_half_seq;
static uint64_t s_port_half_toa;
static uint16_t s_port_half_uwb;
static volatile int64_t s_last_blink_us; /* esp_timer; 0 = never */
static uint32_t s_boat_rx_recoveries;

#define BOAT_BLINK_STALE_US (2500LL * 1000LL)
#define BOAT_BLINK_WATCHDOG_MS 1000U

static void note_blink_rx(void)
{
    s_last_blink_us = esp_timer_get_time();
}

static bool tx_blink(uint8_t role, uint32_t seq, uint16_t fixed_delay_us, uint64_t txtime)
{
    if (twr_in_progress()) {
        ESP_LOGD(TAG, "skip TX role=%c seq=%lu — TWR in progress", (char)role, (unsigned long)seq);
        return false;
    }

    struct txbuf *tx = dwmac_txbuf_get();
    if (tx == NULL) {
        ESP_LOGW(TAG, "TX role=%c seq=%lu — no txbuf", (char)role, (unsigned long)seq);
        return false;
    }

    struct mark_blink_msg *msg =
        dwprot_short_prepare(tx, sizeof(*msg), MARK_BLINK_MSG, 0xffff);
    msg->role = role;
    msg->seq = seq;
    msg->fixed_delay_us = fixed_delay_us;

    if (txtime != 0) {
        dwmac_tx_set_txtime(tx, txtime);
    }

    const bool ok = dwmac_transmit(tx);
    if (ok) {
        ESP_LOGI(TAG, "TX blink role=%c seq=%lu delay_us=%u txtime=%s", (char)role,
                 (unsigned long)seq, (unsigned)fixed_delay_us, txtime ? "delayed" : "now");
    } else {
        ESP_LOGW(TAG, "TX blink FAILED role=%c seq=%lu (delay may be too short for PHY)",
                 (char)role, (unsigned long)seq);
    }
    return ok;
}

static void boat_log_blink(uint8_t role, uint16_t uwb, uint32_t seq, uint16_t delay_us,
                           uint64_t toa)
{
    note_blink_rx();
    ESP_LOGI(TAG, "blink seq=%lu role=%c uwb=0x%04X ToA=%02x%02x%02x%02x%02x delay_us=%u",
             (unsigned long)seq, (char)role, (unsigned)uwb, (unsigned)((toa >> 32) & 0xff),
             (unsigned)((toa >> 24) & 0xff), (unsigned)((toa >> 16) & 0xff),
             (unsigned)((toa >> 8) & 0xff), (unsigned)(toa & 0xff), (unsigned)delay_us);

    if (role == 'P') {
        s_have_port_half = true;
        s_port_half_seq = seq;
        s_port_half_toa = toa;
        s_port_half_uwb = uwb;
        return;
    }

    if (role == 'S' && s_have_port_half && seq == s_port_half_seq) {
        const int64_t dt = (int64_t)toa - (int64_t)s_port_half_toa;
        ESP_LOGI(TAG,
                 "pair seq=%lu ToA_P=%02x%02x%02x%02x%02x ToA_S=%02x%02x%02x%02x%02x "
                 "dt_ticks=%lld delay_us=%u uwb_P=0x%04X uwb_S=0x%04X",
                 (unsigned long)seq, (unsigned)((s_port_half_toa >> 32) & 0xff),
                 (unsigned)((s_port_half_toa >> 24) & 0xff), (unsigned)((s_port_half_toa >> 16) & 0xff),
                 (unsigned)((s_port_half_toa >> 8) & 0xff), (unsigned)(s_port_half_toa & 0xff),
                 (unsigned)((toa >> 32) & 0xff), (unsigned)((toa >> 24) & 0xff),
                 (unsigned)((toa >> 16) & 0xff), (unsigned)((toa >> 8) & 0xff), (unsigned)(toa & 0xff),
                 (long long)dt, (unsigned)delay_us, (unsigned)s_port_half_uwb, (unsigned)uwb);
        s_have_port_half = false;
    }
}

static void on_port_blink_for_starboard(const struct mark_blink_msg *msg, uint64_t rx_ts)
{
    uint16_t delay_us = msg->fixed_delay_us;
    if (delay_us == 0) {
        delay_us = (uint16_t)CONFIG_MARK_BLINK_FIXED_DELAY_US;
    }

    const uint64_t delay_dtu = (uint64_t)US_TO_DTU(delay_us);
    const uint64_t txtime = (rx_ts + delay_dtu) & DTU_DELAYEDTRX_MASK;

    (void)tx_blink('S', msg->seq, delay_us, txtime);
}

bool mark_blink_try_handle(const struct rxbuf *rx)
{
    if (rx == NULL || rx->len < 2) {
        return false;
    }

    const uint16_t fc = *(const uint16_t *)rx->buf;
    if ((fc & MAC154_FC_TYPE_DATA) == 0) {
        return false;
    }
    if (!dwprot_check_min_len(rx->buf, rx->len)) {
        return false;
    }
    if (dwprot_get_func(rx->buf) != MARK_BLINK_MSG) {
        return false;
    }
    if (dwprot_get_payload_len(rx->buf, rx->len) != sizeof(struct mark_blink_msg)) {
        ESP_LOGW(TAG, "drop blink: bad payload len");
        return true;
    }

    const struct mark_blink_msg *msg = dwprot_get_payload(rx->buf);
    const uint16_t src = (uint16_t)dwprot_get_src(rx->buf);
    const uint64_t rx_ts = rx->ts & DTU_MASK;
    const uint64_t toa = dw_timestamp_extend(rx_ts);
    const device_type_t me = device_type_get();

    if (me == DEVICE_TYPE_STARBOARD && msg->role == 'P') {
        on_port_blink_for_starboard(msg, rx_ts);
        ESP_LOGI(TAG, "RX Port blink seq=%lu uwb=0x%04X — scheduled S reply",
                 (unsigned long)msg->seq, (unsigned)src);
        return true;
    }

    if (me == DEVICE_TYPE_BOAT) {
        boat_log_blink(msg->role, src, msg->seq, msg->fixed_delay_us, toa);
        return true;
    }

    /* Port (and others): ignore peer blinks for now. */
    ESP_LOGD(TAG, "RX blink role=%c seq=%lu uwb=0x%04X (ignored locally)", (char)msg->role,
             (unsigned long)msg->seq, (unsigned)src);
    return true;
}

static void port_blink_task(void *arg)
{
    (void)arg;
    const uint32_t interval_ms = (uint32_t)CONFIG_MARK_BLINK_INTERVAL_MS;
    const uint16_t delay_us = (uint16_t)CONFIG_MARK_BLINK_FIXED_DELAY_US;

    /* Small stagger so simultaneous boots don't align with peer TWR. */
    vTaskDelay(pdMS_TO_TICKS(200 + (dw3000_ranging_self_addr() & 0x1FFU)));

    for (;;) {
        if (device_type_get() == DEVICE_TYPE_PORT) {
            const uint32_t seq = ++s_port_seq;
            (void)tx_blink('P', seq, delay_us, 0);
        }
        vTaskDelay(pdMS_TO_TICKS(interval_ms));
    }
}

/**
 * Boat UWB RX can stall after Meshtastic companion UART bursts (RX left off /
 * error state). Periodically re-arm RX; if blinks go stale, force TRX off→RX.
 */
static void boat_blink_watchdog_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(BOAT_BLINK_WATCHDOG_MS));
        if (device_type_get() != DEVICE_TYPE_BOAT) {
            continue;
        }
        if (twr_in_progress()) {
            continue;
        }

        const int64_t now = esp_timer_get_time();
        const int64_t last = s_last_blink_us;
        const int64_t age_us = (last > 0) ? (now - last) : now;

        /* Cheap heartbeat — keeps RX on after transient errors. */
        dwmac_rx_reenable();

        if (age_us < BOAT_BLINK_STALE_US) {
            continue;
        }

        s_boat_rx_recoveries++;
        ESP_LOGW(TAG,
                 "boat UWB sniff stale (no blink for %lld ms) — forcetrxoff + RX re-arm #%lu",
                 (long long)(age_us / 1000), (unsigned long)s_boat_rx_recoveries);
        dwt_forcetrxoff();
        dwmac_rx_reenable();
    }
}

esp_err_t mark_blink_start(void)
{
    if (s_started) {
        return ESP_OK;
    }

    const device_type_t t = device_type_get();
    if (t == DEVICE_TYPE_PORT) {
        if (xTaskCreate(port_blink_task, "mark_blink", 3072, NULL, 5, NULL) != pdPASS) {
            ESP_LOGE(TAG, "port blink task create failed");
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "Port blink TX started (interval=%u ms, fixed_delay=%u us)",
                 (unsigned)CONFIG_MARK_BLINK_INTERVAL_MS,
                 (unsigned)CONFIG_MARK_BLINK_FIXED_DELAY_US);
    } else if (t == DEVICE_TYPE_STARBOARD) {
        ESP_LOGI(TAG, "Starboard blink reply armed (fixed_delay default %u us)",
                 (unsigned)CONFIG_MARK_BLINK_FIXED_DELAY_US);
    } else if (t == DEVICE_TYPE_BOAT) {
        s_last_blink_us = 0;
        if (xTaskCreate(boat_blink_watchdog_task, "blink_wd", 3072, NULL, 6, NULL) != pdPASS) {
            ESP_LOGE(TAG, "boat blink watchdog create failed");
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "Boat blink sniff armed (UWB TX suppressed; RX watchdog %u ms)",
                 (unsigned)BOAT_BLINK_WATCHDOG_MS);
    } else {
        ESP_LOGI(TAG, "mark blink idle (device type %d)", (int)t);
    }

    s_started = true;
    return ESP_OK;
}

#else /* !CONFIG_DW3000_RANGING_ENABLE */

bool mark_blink_try_handle(const struct rxbuf *rx)
{
    (void)rx;
    return false;
}

esp_err_t mark_blink_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
