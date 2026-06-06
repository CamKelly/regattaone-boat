#include "sx1262_lora.h"

#if CONFIG_REGATTAONE_SX1262_ENABLE

#include "EspHal.h"

#include "modules/SX126x/SX1262.h"

#include "ble_sen0140.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "gps_timebase.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "modules/SX126x/SX126x_commands.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "tdma.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>

static const char *TAG = "sx1262";

static EspHal *s_hal = nullptr;
static Module *s_module = nullptr;
static SX1262 *s_radio = nullptr;
static bool s_modem_ready = false;
static bool s_tasks_started = false;
static sx1262_lora_status_t s_status = SX1262_LORA_STATUS_NOT_STARTED;

static SemaphoreHandle_t s_radio_mtx = nullptr;
static SemaphoreHandle_t s_tx_q_mtx = nullptr;

static constexpr float kLoRaBwKhz = 125.0f;
static constexpr uint8_t kLoRaSf = 9;
static constexpr uint8_t kLoRaCr = 7;
static constexpr uint32_t kRxPollMs = (uint32_t)CONFIG_SX1262_RX_POLL_MS;

struct sx1262_tx_item_t {
    uint8_t data[256];
    uint16_t len;
    int64_t deadline_us;
    bool skip_tdma;
};

static sx1262_tx_item_t s_tx_q[CONFIG_SX1262_TX_QUEUE_DEPTH];
static size_t s_tx_q_count = 0;
static uint32_t s_consecutive_radio_errors = 0;

static const char *radiolib_err_name(int code)
{
    switch (code) {
    case RADIOLIB_ERR_NONE:
        return "ERR_NONE";
    case RADIOLIB_ERR_CHIP_NOT_FOUND:
        return "ERR_CHIP_NOT_FOUND";
    case RADIOLIB_ERR_TX_TIMEOUT:
        return "ERR_TX_TIMEOUT";
    case RADIOLIB_ERR_RX_TIMEOUT:
        return "ERR_RX_TIMEOUT";
    case RADIOLIB_ERR_CRC_MISMATCH:
        return "ERR_CRC_MISMATCH";
    case RADIOLIB_ERR_WRONG_MODEM:
        return "ERR_WRONG_MODEM";
    case RADIOLIB_CHANNEL_FREE:
        return "CHANNEL_FREE";
    case RADIOLIB_LORA_DETECTED:
        return "LORA_DETECTED";
    case RADIOLIB_ERR_SPI_CMD_FAILED:
        return "ERR_SPI_CMD_FAILED";
    case RADIOLIB_ERR_SPI_CMD_TIMEOUT:
        return "ERR_SPI_CMD_TIMEOUT";
    case RADIOLIB_ERR_SPI_CMD_INVALID:
        return "ERR_SPI_CMD_INVALID";
    default:
        return "ERR_UNKNOWN";
    }
}

static float sx1262_tcxo_voltage_v(void)
{
    return (float)CONFIG_SX1262_TCXO_VOLTAGE_MV / 1000.0f;
}

static int sx1262_modem_begin_locked(void)
{
    const float freq_mhz = (float)SX1262_FREQ_HZ / 1000000.0f;
    return s_radio->begin(freq_mhz, kLoRaBwKhz, kLoRaSf, kLoRaCr, RADIOLIB_SX126X_SYNC_WORD_PRIVATE,
                          (int8_t)SX1262_TX_POWER_DBM, 8, sx1262_tcxo_voltage_v(), false);
}

static void sx1262_note_radio_ok(void)
{
    s_consecutive_radio_errors = 0;
}

static spi_host_device_t sx1262_spi_host(void)
{
#if CONFIG_SX1262_SPI_HOST_NUM == 3
    return SPI3_HOST;
#else
    return SPI2_HOST;
#endif
}

static int sx1262_kconfig_gpio(int gpio)
{
    return gpio >= 0 ? gpio : RADIOLIB_NC;
}

static void lora_line_notifyf(const char *fmt, ...)
{
    char line[320];
    va_list ap;
    va_start(ap, fmt);
    const int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n > 0) {
        ble_sen0140_lora_line_notify((const uint8_t *)line, (size_t)n);
    }
}

static bool sx1262_recover_modem_locked(void)
{
    ESP_LOGW(TAG, "recovering modem (re-begin, tcxo=%.3f V)", (double)sx1262_tcxo_voltage_v());
    lora_line_notifyf("! radio recover (re-begin, tcxo %.3f V)\n", (double)sx1262_tcxo_voltage_v());

    const int st = sx1262_modem_begin_locked();
    if (st != RADIOLIB_ERR_NONE) {
        ESP_LOGE(TAG, "recover begin failed: %s (%d)", radiolib_err_name(st), st);
        return false;
    }

    const int rx = s_radio->startReceive();
    if (rx != RADIOLIB_ERR_NONE) {
        ESP_LOGE(TAG, "recover startReceive failed: %s (%d)", radiolib_err_name(rx), rx);
        return false;
    }

    sx1262_note_radio_ok();
    ESP_LOGI(TAG, "modem recovered");
    lora_line_notifyf("! radio recovered\n");
    return true;
}

static bool sx1262_handle_radio_error_locked(int code)
{
#if CONFIG_SX1262_RECOVER_AFTER_ERRORS > 0
    s_consecutive_radio_errors++;
    if (s_consecutive_radio_errors >= (uint32_t)CONFIG_SX1262_RECOVER_AFTER_ERRORS) {
        s_consecutive_radio_errors = 0;
        return sx1262_recover_modem_locked();
    }
#else
    (void)code;
#endif
    return false;
}

#if CONFIG_REGATTAONE_GPS_ENABLE && CONFIG_SX1262_GPS_LATENCY

static constexpr size_t SX1262_TX_STAMP_BYTES = 4U;

/** Build over-the-air buffer; may prepend 4-byte UTC ms (LE) when GPS UTC is valid. */
static size_t sx1262_build_on_air(const sx1262_tx_item_t &item, uint8_t *out, size_t out_cap)
{
    if (gps_timebase_utc_valid()) {
        const size_t on_air_len = SX1262_TX_STAMP_BYTES + item.len;
        if (on_air_len <= out_cap && on_air_len <= 255U) {
            const uint32_t tx_ms = (uint32_t)(gps_timebase_now_us() / 1000LL);
            memcpy(out, &tx_ms, SX1262_TX_STAMP_BYTES);
            memcpy(out + SX1262_TX_STAMP_BYTES, item.data, item.len);
            return on_air_len;
        }
    }
    if (item.len > out_cap || item.len > 255U) {
        return 0;
    }
    memcpy(out, item.data, item.len);
    return item.len;
}

static bool sx1262_parse_legacy_ts_prefix(const uint8_t *data, size_t len, int64_t *tx_utc_us, const uint8_t **payload,
                                          size_t *payload_len)
{
    if (data == nullptr || len < 5U || tx_utc_us == nullptr || payload == nullptr || payload_len == nullptr) {
        return false;
    }
    if (memcmp(data, "TS=", 3) != 0) {
        return false;
    }

    size_t i = 3U;
    int64_t ts = 0;
    bool any = false;
    while (i < len && data[i] >= '0' && data[i] <= '9') {
        any = true;
        ts = ts * 10LL + (int64_t)(data[i] - '0');
        i++;
    }
    if (!any || i >= len || data[i] != '\n') {
        return false;
    }
    i++;

    *tx_utc_us = ts;
    *payload = data + i;
    *payload_len = len - i;
    return true;
}

static bool sx1262_one_way_latency_ms_u32(uint32_t tx_ms, uint32_t rx_ms, int64_t *latency_ms)
{
    if (latency_ms == nullptr || !gps_timebase_utc_valid()) {
        return false;
    }
    const uint32_t delta_ms = rx_ms - tx_ms;
    if (delta_ms > 120U * 1000U) {
        return false;
    }
    *latency_ms = (int64_t)delta_ms;
    return true;
}

static bool sx1262_one_way_latency_ms_us(int64_t tx_utc_us, int64_t rx_utc_us, int64_t *latency_ms)
{
    if (latency_ms == nullptr || tx_utc_us <= 0 || rx_utc_us <= 0 || !gps_timebase_utc_valid()) {
        return false;
    }
    const int64_t delta_us = rx_utc_us - tx_utc_us;
    if (delta_us < 0 || delta_us > 120LL * 1000000LL) {
        return false;
    }
    *latency_ms = (delta_us + 999) / 1000;
    return true;
}

static bool sx1262_likely_binary_stamp(const uint8_t *data, size_t len)
{
    if (data == nullptr || len <= SX1262_TX_STAMP_BYTES) {
        return false;
    }
    if (len >= 3U && memcmp(data, "TS=", 3) == 0) {
        return false;
    }
    for (size_t i = 0; i < SX1262_TX_STAMP_BYTES; i++) {
        const uint8_t b = data[i];
        if (b < 0x20U || b > 0x7EU) {
            return true;
        }
    }
    return false;
}

static void sx1262_log_rx_packet(const uint8_t *buf, size_t len, float rssi, float snr)
{
    const uint8_t *payload = buf;
    size_t payload_len = len;
    int64_t latency_ms = -1;
    bool stripped_stamp = false;

    int64_t legacy_tx_utc_us = 0;
    if (sx1262_parse_legacy_ts_prefix(buf, len, &legacy_tx_utc_us, &payload, &payload_len)) {
        stripped_stamp = true;
        int64_t ms = 0;
        if (sx1262_one_way_latency_ms_us(legacy_tx_utc_us, gps_timebase_now_us(), &ms)) {
            latency_ms = ms;
        }
    } else if (len >= SX1262_TX_STAMP_BYTES) {
        uint32_t tx_ms = 0;
        memcpy(&tx_ms, buf, SX1262_TX_STAMP_BYTES);
        const uint32_t rx_ms = (uint32_t)(gps_timebase_now_us() / 1000LL);
        int64_t ms = 0;
        if (sx1262_one_way_latency_ms_u32(tx_ms, rx_ms, &ms)) {
            latency_ms = ms;
            payload = buf + SX1262_TX_STAMP_BYTES;
            payload_len = len - SX1262_TX_STAMP_BYTES;
            stripped_stamp = true;
        } else if (sx1262_likely_binary_stamp(buf, len)) {
            payload = buf + SX1262_TX_STAMP_BYTES;
            payload_len = len - SX1262_TX_STAMP_BYTES;
            stripped_stamp = true;
        }
    }

    if (latency_ms >= 0) {
        ESP_LOGI(TAG, "RX %u bytes, RSSI %.1f dBm, SNR %.1f dB, latency %lld ms: %.*s", (unsigned)payload_len,
                 (double)rssi, (double)snr, (long long)latency_ms, (int)payload_len, (const char *)payload);
        lora_line_notifyf("RX %u bytes RSSI %.1f SNR %.1f latency %lld ms: %.*s\n", (unsigned)payload_len,
                          (double)rssi, (double)snr, (long long)latency_ms, (int)payload_len,
                          (const char *)payload);
    } else if (stripped_stamp) {
        ESP_LOGI(TAG, "RX %u bytes, RSSI %.1f dBm, SNR %.1f dB (latency n/a, GPS/PPS not synced): %.*s",
                 (unsigned)payload_len, (double)rssi, (double)snr, (int)payload_len, (const char *)payload);
        lora_line_notifyf("RX %u bytes RSSI %.1f SNR %.1f (latency n/a, GPS/PPS not synced): %.*s\n",
                          (unsigned)payload_len, (double)rssi, (double)snr, (int)payload_len,
                          (const char *)payload);
    } else {
        ESP_LOGI(TAG, "RX %u bytes, RSSI %.1f dBm, SNR %.1f dB: %.*s", (unsigned)payload_len, (double)rssi,
                 (double)snr, (int)payload_len, (const char *)payload);
        lora_line_notifyf("RX %u bytes RSSI %.1f SNR %.1f: %.*s\n", (unsigned)payload_len, (double)rssi,
                          (double)snr, (int)payload_len, (const char *)payload);
    }
}

#endif /* CONFIG_REGATTAONE_GPS_ENABLE && CONFIG_SX1262_GPS_LATENCY */

const char *sx1262_lora_status_text(void)
{
    switch (s_status) {
    case SX1262_LORA_STATUS_DISABLED:
        return "disabled (CONFIG_REGATTAONE_SX1262_ENABLE=n)";
    case SX1262_LORA_STATUS_INIT_FAILED:
        return "init failed";
    case SX1262_LORA_STATUS_NOT_STARTED:
        return "modem ok, RX/TX tasks not running";
    case SX1262_LORA_STATUS_READY:
        return "ready";
    default:
        return "unknown";
    }
}

void sx1262_lora_emit_status(void)
{
    lora_line_notifyf("! STATUS: %s\n", sx1262_lora_status_text());
}

void sx1262_lora_on_line_notify_subscribed(void)
{
    sx1262_lora_emit_status();
}

static void set_status(sx1262_lora_status_t st)
{
    if (s_status == st) {
        return;
    }
    s_status = st;
    sx1262_lora_emit_status();
}

static bool parse_tx_write(const uint8_t *in, size_t in_len, uint8_t *payload, size_t *payload_len, uint32_t *ttl_ms)
{
    if (in == nullptr || in_len == 0U || payload == nullptr || payload_len == nullptr || ttl_ms == nullptr) {
        return false;
    }

    *ttl_ms = (uint32_t)CONFIG_SX1262_TX_DEFAULT_TTL_MS;

    if (in_len >= 5U && memcmp(in, "TTL=", 4) == 0) {
        size_t i = 4U;
        uint32_t ttl = 0;
        bool any = false;
        while (i < in_len && in[i] >= '0' && in[i] <= '9') {
            any = true;
            ttl = ttl * 10U + (uint32_t)(in[i] - '0');
            if (ttl > 600000U) {
                ttl = 600000U;
            }
            i++;
        }
        if (any && i < in_len && in[i] == '\n') {
            *ttl_ms = ttl > 0U ? ttl : (uint32_t)CONFIG_SX1262_TX_DEFAULT_TTL_MS;
            i++;
            const size_t plen = in_len - i;
            if (plen == 0U || plen > 255U) {
                return false;
            }
            memcpy(payload, in + i, plen);
            *payload_len = plen;
            return true;
        }
    }

    if (in_len > 255U) {
        return false;
    }
    memcpy(payload, in, in_len);
    *payload_len = in_len;
    return true;
}

static esp_err_t tx_q_push(const uint8_t *data, size_t len, uint32_t ttl_ms, bool skip_tdma)
{
    if (!s_modem_ready || data == nullptr || len == 0U || len > 255U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_tx_q_mtx == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }

    const int64_t now_us = (int64_t)esp_timer_get_time();
    const int64_t ttl_us = (int64_t)(ttl_ms > 0U ? ttl_ms : (uint32_t)CONFIG_SX1262_TX_DEFAULT_TTL_MS) * 1000;

    xSemaphoreTake(s_tx_q_mtx, portMAX_DELAY);
    if (s_tx_q_count >= CONFIG_SX1262_TX_QUEUE_DEPTH) {
        xSemaphoreGive(s_tx_q_mtx);
        lora_line_notifyf("! TX queue full (max %d)\n", CONFIG_SX1262_TX_QUEUE_DEPTH);
        return ESP_ERR_NO_MEM;
    }

    sx1262_tx_item_t &item = s_tx_q[s_tx_q_count++];
    memcpy(item.data, data, len);
    item.len = (uint16_t)len;
    item.deadline_us = now_us + ttl_us;
    item.skip_tdma = skip_tdma;
    const size_t depth = s_tx_q_count;
    xSemaphoreGive(s_tx_q_mtx);

    ESP_LOGI(TAG, "TX queued %u bytes ttl=%lu ms depth=%u", (unsigned)len, (unsigned long)ttl_ms, (unsigned)depth);
    lora_line_notifyf("TX queued %u bytes (ttl %lu ms, depth %u)\n", (unsigned)len, (unsigned long)ttl_ms,
                      (unsigned)depth);
    return ESP_OK;
}

static bool tx_q_peek(sx1262_tx_item_t *out)
{
    if (out == nullptr || s_tx_q_mtx == nullptr) {
        return false;
    }
    xSemaphoreTake(s_tx_q_mtx, portMAX_DELAY);
    const bool have = s_tx_q_count > 0U;
    if (have) {
        *out = s_tx_q[0];
    }
    xSemaphoreGive(s_tx_q_mtx);
    return have;
}

static void tx_q_pop(void)
{
    if (s_tx_q_mtx == nullptr) {
        return;
    }
    xSemaphoreTake(s_tx_q_mtx, portMAX_DELAY);
    if (s_tx_q_count > 0U) {
        for (size_t i = 1; i < s_tx_q_count; i++) {
            s_tx_q[i - 1] = s_tx_q[i];
        }
        s_tx_q_count--;
    }
    xSemaphoreGive(s_tx_q_mtx);
}

static bool tx_q_non_empty(void)
{
    if (s_tx_q_mtx == nullptr) {
        return false;
    }
    xSemaphoreTake(s_tx_q_mtx, portMAX_DELAY);
    const bool have = s_tx_q_count > 0U;
    xSemaphoreGive(s_tx_q_mtx);
    return have;
}

/** Avoid flooding 0xFEF8 notifies (starves NimBLE mbuf pool → GATT write fails). */
static void rx_error_throttled(int state)
{
    static uint32_t s_err_count;
    static int64_t s_last_ble_notify_us;
    s_err_count++;

    if (s_err_count == 1U || (s_err_count % 32U) == 0U) {
        ESP_LOGW(TAG, "RX error: %s (%d, count=%lu)", radiolib_err_name(state), state,
                 (unsigned long)s_err_count);
    }

    const int64_t now_us = (int64_t)esp_timer_get_time();
    if (now_us - s_last_ble_notify_us < 3000000) {
        return;
    }
    s_last_ble_notify_us = now_us;
    lora_line_notifyf("! RX error %s (%d)\n", radiolib_err_name(state), state);
}

static bool sx1262_restart_receive_locked(void)
{
    const int st = s_radio->startReceive();
    if (st == RADIOLIB_ERR_NONE) {
        sx1262_note_radio_ok();
        return true;
    }
    ESP_LOGW(TAG, "startReceive: %s (%d)", radiolib_err_name(st), st);
    return sx1262_handle_radio_error_locked(st);
}

static uint32_t cad_backoff_ms(size_t payload_len)
{
    const RadioLibTime_t air_us = s_radio->getTimeOnAir(payload_len > 0U ? payload_len : 32U);
    uint32_t slot_ms = (uint32_t)((air_us + 999ULL) / 1000ULL);
    if (slot_ms < 50U) {
        slot_ms = 50U;
    }
    if (slot_ms > 800U) {
        slot_ms = 800U;
    }
    const uint32_t jitter = (uint32_t)(esp_random() % (slot_ms + 1U));
    return slot_ms + jitter;
}

static void sx1262_rx_task(void *arg)
{
    (void)arg;
    uint8_t buf[256];

    for (;;) {
        if (!s_modem_ready || s_radio == nullptr || s_radio_mtx == nullptr) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        /* Let the TX worker own the radio while the queue has work (avoid mutex starvation). */
        if (tx_q_non_empty()) {
            vTaskDelay(pdMS_TO_TICKS(25));
            continue;
        }

        vTaskDelay(pdMS_TO_TICKS(kRxPollMs));

#if SX1262_DIO1_GPIO >= 0
        if (gpio_get_level((gpio_num_t)SX1262_DIO1_GPIO) == 0) {
            continue;
        }
#endif

        if (xSemaphoreTake(s_radio_mtx, pdMS_TO_TICKS(500)) != pdTRUE) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        const uint32_t irq = s_radio->getIrqFlags();
        if (!(irq & RADIOLIB_SX126X_IRQ_RX_DONE)) {
            /* DIO1 high without RX_DONE (CAD/TX/stale IRQ on shared DIO1): ignore. */
            xSemaphoreGive(s_radio_mtx);
            continue;
        }

        const int state = s_radio->readData(buf, sizeof(buf) - 1U);
        (void)sx1262_restart_receive_locked();

        if (state == RADIOLIB_ERR_NONE) {
            const size_t len = s_radio->getPacketLength();
            if (len >= sizeof(buf)) {
                buf[sizeof(buf) - 1U] = '\0';
            } else {
                buf[len] = '\0';
            }
#if CONFIG_REGATTAONE_GPS_ENABLE && CONFIG_SX1262_GPS_LATENCY
            sx1262_log_rx_packet(buf, len, s_radio->getRSSI(), s_radio->getSNR());
#else
            ESP_LOGI(TAG, "RX %u bytes, RSSI %.1f dBm, SNR %.1f dB: %.*s", (unsigned)len, s_radio->getRSSI(),
                     s_radio->getSNR(), (int)len, (const char *)buf);
            lora_line_notifyf("RX %u bytes RSSI %.1f SNR %.1f: %.*s\n", (unsigned)len, (double)s_radio->getRSSI(),
                              (double)s_radio->getSNR(), (int)len, (const char *)buf);
#endif
        } else if (state == RADIOLIB_ERR_CRC_MISMATCH) {
            ESP_LOGW(TAG, "RX CRC mismatch RSSI %.1f SNR %.1f", (double)s_radio->getRSSI(), (double)s_radio->getSNR());
            lora_line_notifyf("! RX CRC mismatch RSSI %.1f SNR %.1f\n", (double)s_radio->getRSSI(),
                              (double)s_radio->getSNR());
        } else if (state != RADIOLIB_ERR_RX_TIMEOUT) {
            rx_error_throttled(state);
            vTaskDelay(pdMS_TO_TICKS(100));
        }

        xSemaphoreGive(s_radio_mtx);
    }
}

static void sx1262_tx_task(void *arg)
{
    (void)arg;

    for (;;) {
        if (!s_modem_ready || s_radio == nullptr || s_radio_mtx == nullptr) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        sx1262_tx_item_t item{};
        if (!tx_q_peek(&item)) {
            vTaskDelay(pdMS_TO_TICKS(25));
            continue;
        }

        const int64_t now_us = (int64_t)esp_timer_get_time();
        if (now_us >= item.deadline_us) {
            tx_q_pop();
            ESP_LOGW(TAG, "TX expired (%u bytes)", (unsigned)item.len);
#if CONFIG_REGATTAONE_TDMA_ENABLE && CONFIG_TDMA_ENFORCE_LORA_TX
            if (!item.skip_tdma && gps_timebase_utc_valid()) {
                lora_line_notifyf("! TX expired (%u bytes): no TDMA slot before TTL (try again)\n",
                                  (unsigned)item.len);
            } else {
                lora_line_notifyf("! TX expired (%u bytes): radio busy or CAD (see serial log)\n",
                                  (unsigned)item.len);
            }
#else
            lora_line_notifyf("! TX expired (%u bytes), discarded\n", (unsigned)item.len);
#endif
            continue;
        }

#if CONFIG_REGATTAONE_TDMA_ENABLE && CONFIG_TDMA_ENFORCE_LORA_TX
        if (!item.skip_tdma && !tdma_can_transmit_now()) {
            static int64_t s_last_slot_wait_log_us;
            const int64_t tnow = (int64_t)esp_timer_get_time();
            if (tnow - s_last_slot_wait_log_us >= 5000000) {
                s_last_slot_wait_log_us = tnow;
                const int64_t wait_us = tdma_us_until_tx_window();
                ESP_LOGI(TAG, "TX waiting for TDMA slot (~%lld ms)", (long long)((wait_us + 999) / 1000));
                lora_line_notifyf("! TX waiting for TDMA slot (~%lld ms)\n",
                                  (long long)((wait_us + 999) / 1000));
            }
            const int64_t wait_us = tdma_us_until_tx_window();
            if (wait_us > 0) {
                const uint32_t wait_ms = (uint32_t)((wait_us + 999) / 1000);
                vTaskDelay(pdMS_TO_TICKS(wait_ms > 500U ? 500U : wait_ms));
            } else {
                vTaskDelay(pdMS_TO_TICKS(20));
            }
            continue;
        }
#endif

        if (xSemaphoreTake(s_radio_mtx, pdMS_TO_TICKS(2000)) != pdTRUE) {
            ESP_LOGW(TAG, "TX waiting for radio mutex");
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        int cad = s_radio->scanChannel();
        if (cad == RADIOLIB_LORA_DETECTED) {
            const uint32_t backoff_ms = cad_backoff_ms(item.len);
            (void)sx1262_restart_receive_locked();
            xSemaphoreGive(s_radio_mtx);
            ESP_LOGD(TAG, "CAD busy, backoff %lu ms", (unsigned long)backoff_ms);
            lora_line_notifyf("! CAD busy, backoff %lu ms\n", (unsigned long)backoff_ms);
            vTaskDelay(pdMS_TO_TICKS(backoff_ms));
            continue;
        }
        if (cad != RADIOLIB_CHANNEL_FREE) {
            (void)sx1262_restart_receive_locked();
            xSemaphoreGive(s_radio_mtx);
            ESP_LOGW(TAG, "scanChannel failed: %s (%d)", radiolib_err_name(cad), cad);
            lora_line_notifyf("! CAD error %s (%d)\n", radiolib_err_name(cad), cad);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        uint8_t on_air[256];
        size_t on_air_len = item.len;
#if CONFIG_REGATTAONE_GPS_ENABLE && CONFIG_SX1262_GPS_LATENCY
        on_air_len = sx1262_build_on_air(item, on_air, sizeof(on_air));
        if (on_air_len == 0U) {
            xSemaphoreGive(s_radio_mtx);
            ESP_LOGW(TAG, "TX framing failed (%u bytes)", (unsigned)item.len);
            vTaskDelay(pdMS_TO_TICKS(80));
            continue;
        }
#else
        memcpy(on_air, item.data, item.len);
#endif

        const int tx_state = s_radio->transmit(on_air, on_air_len);
        if (tx_state != RADIOLIB_ERR_NONE) {
            (void)sx1262_restart_receive_locked();
            xSemaphoreGive(s_radio_mtx);
            ESP_LOGW(TAG, "transmit failed: %s (%d)", radiolib_err_name(tx_state), tx_state);
            lora_line_notifyf("! TX failed %s (%d)\n", radiolib_err_name(tx_state), tx_state);
            vTaskDelay(pdMS_TO_TICKS(80));
            continue;
        }

        tx_q_pop();
        (void)sx1262_restart_receive_locked();
        xSemaphoreGive(s_radio_mtx);

        ESP_LOGI(TAG, "TX ok %u bytes", (unsigned)item.len);
        lora_line_notifyf("TX ok %u bytes: %.*s\n", (unsigned)item.len, (int)item.len, (const char *)item.data);
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

extern "C" esp_err_t sx1262_lora_init(void)
{
    if (s_modem_ready) {
        return ESP_OK;
    }

    s_radio_mtx = xSemaphoreCreateMutex();
    s_tx_q_mtx = xSemaphoreCreateMutex();
    if (s_radio_mtx == nullptr || s_tx_q_mtx == nullptr) {
        set_status(SX1262_LORA_STATUS_INIT_FAILED);
        return ESP_ERR_NO_MEM;
    }

    s_hal = new EspHal((int8_t)SX1262_SPI_SCLK_GPIO, (int8_t)SX1262_SPI_MISO_GPIO, (int8_t)SX1262_SPI_MOSI_GPIO,
                       sx1262_spi_host(), (uint32_t)SX1262_SPI_FREQ_HZ);

    s_module = new Module(s_hal, (uint32_t)SX1262_SPI_CS_GPIO, (uint32_t)SX1262_DIO1_GPIO,
                          (uint32_t)sx1262_kconfig_gpio(SX1262_RESET_GPIO),
                          (uint32_t)sx1262_kconfig_gpio(SX1262_BUSY_GPIO));
    s_radio = new SX1262(s_module);

    const float freq_mhz = (float)SX1262_FREQ_HZ / 1000000.0f;
    const int state = sx1262_modem_begin_locked();
    if (state != RADIOLIB_ERR_NONE) {
        if (state == RADIOLIB_ERR_CHIP_NOT_FOUND) {
            ESP_LOGE(TAG,
                     "SX1262 begin failed: chip not found (check 3.3V; SPI MOSI=%d MISO=%d SCK=%d CS=%d RST=%d BUSY=%d)",
                     SX1262_SPI_MOSI_GPIO, SX1262_SPI_MISO_GPIO, SX1262_SPI_SCLK_GPIO, SX1262_SPI_CS_GPIO,
                     SX1262_RESET_GPIO, SX1262_BUSY_GPIO);
        } else {
            ESP_LOGE(TAG, "SX1262 begin failed: %s (%d) tcxo=%.3f V (menuconfig SX1262_TCXO_VOLTAGE_MV)",
                     radiolib_err_name(state), state, (double)sx1262_tcxo_voltage_v());
        }
        set_status(SX1262_LORA_STATUS_INIT_FAILED);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG,
             "SX1262 ready: SPI%d MOSI=%d MISO=%d SCK=%d CS=%d RST=%d DIO1=%d BUSY=%d freq=%.3f MHz bw=%.0f sf=%u cr=%u tx=%d dBm tcxo=%.3f V",
             CONFIG_SX1262_SPI_HOST_NUM, SX1262_SPI_MOSI_GPIO, SX1262_SPI_MISO_GPIO, SX1262_SPI_SCLK_GPIO,
             SX1262_SPI_CS_GPIO, SX1262_RESET_GPIO, SX1262_DIO1_GPIO, SX1262_BUSY_GPIO, (double)freq_mhz,
             (double)kLoRaBwKhz, (unsigned)kLoRaSf, (unsigned)kLoRaCr, SX1262_TX_POWER_DBM,
             (double)sx1262_tcxo_voltage_v());

    s_modem_ready = true;
    set_status(SX1262_LORA_STATUS_NOT_STARTED);
    return ESP_OK;
}

extern "C" esp_err_t sx1262_lora_start(void)
{
    if (!s_modem_ready || s_radio == nullptr) {
        set_status(SX1262_LORA_STATUS_INIT_FAILED);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_tasks_started) {
        return ESP_OK;
    }

    if (xTaskCreate(sx1262_rx_task, "sx1262_rx", 4096, nullptr, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "RX task create failed");
        set_status(SX1262_LORA_STATUS_NOT_STARTED);
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreate(sx1262_tx_task, "sx1262_tx", 4096, nullptr, 6, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "TX task create failed");
        set_status(SX1262_LORA_STATUS_NOT_STARTED);
        return ESP_ERR_NO_MEM;
    }

    if (xSemaphoreTake(s_radio_mtx, pdMS_TO_TICKS(2000)) == pdTRUE) {
        (void)sx1262_restart_receive_locked();
        xSemaphoreGive(s_radio_mtx);
    }

    s_tasks_started = true;
    set_status(SX1262_LORA_STATUS_READY);
    ESP_LOGI(TAG, "LoRa RX/TX tasks started (CAD queue, TTL default %d ms)", CONFIG_SX1262_TX_DEFAULT_TTL_MS);
    return ESP_OK;
}

extern "C" esp_err_t sx1262_lora_enqueue(const uint8_t *data, size_t len, uint32_t ttl_ms)
{
    return tx_q_push(data, len, ttl_ms, false);
}

extern "C" esp_err_t sx1262_lora_transmit(const uint8_t *data, size_t len)
{
    uint8_t payload[256];
    size_t payload_len = 0;
    uint32_t ttl_ms = 0;
    if (!parse_tx_write(data, len, payload, &payload_len, &ttl_ms)) {
        return ESP_ERR_INVALID_ARG;
    }
    return tx_q_push(payload, payload_len, ttl_ms, false);
}

extern "C" esp_err_t sx1262_lora_transmit_unscheduled(const uint8_t *data, size_t len)
{
    uint8_t payload[256];
    size_t payload_len = 0;
    uint32_t ttl_ms = 0;
    if (!parse_tx_write(data, len, payload, &payload_len, &ttl_ms)) {
        return ESP_ERR_INVALID_ARG;
    }
    return tx_q_push(payload, payload_len, ttl_ms, true);
}

#else /* !CONFIG_REGATTAONE_SX1262_ENABLE */

const char *sx1262_lora_status_text(void) { return "disabled (CONFIG_REGATTAONE_SX1262_ENABLE=n)"; }

void sx1262_lora_emit_status(void) {}

void sx1262_lora_on_line_notify_subscribed(void) {}

extern "C" esp_err_t sx1262_lora_init(void) { return ESP_ERR_NOT_SUPPORTED; }

extern "C" esp_err_t sx1262_lora_start(void) { return ESP_ERR_NOT_SUPPORTED; }

extern "C" esp_err_t sx1262_lora_enqueue(const uint8_t *data, size_t len, uint32_t ttl_ms)
{
    (void)data;
    (void)len;
    (void)ttl_ms;
    return ESP_ERR_NOT_SUPPORTED;
}

extern "C" esp_err_t sx1262_lora_transmit(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

extern "C" esp_err_t sx1262_lora_transmit_unscheduled(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */
