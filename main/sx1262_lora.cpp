#include "sx1262_lora.h"

#if CONFIG_REGATTAONE_SX1262_ENABLE

#include "radiolib_esp_hal.hpp"

#include "modules/SX126x/SX1262.h"

#include "ble_sen0140.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "sx1262";

static EspHal *s_hal = nullptr;
static Module *s_module = nullptr;
static SX1262 *s_radio = nullptr;
static bool s_ready = false;

static constexpr float kLoRaBwKhz = 125.0f;
static constexpr uint8_t kLoRaSf = 9;
static constexpr uint8_t kLoRaCr = 7;

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

static void sx1262_rx_task(void *arg)
{
    (void)arg;
    uint8_t buf[256];

    for (;;) {
        if (!s_ready || s_radio == nullptr) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        const int state = s_radio->readData(buf, sizeof(buf) - 1U);
        if (state == RADIOLIB_ERR_NONE) {
            const size_t len = s_radio->getPacketLength();
            if (len >= sizeof(buf)) {
                buf[sizeof(buf) - 1U] = '\0';
            } else {
                buf[len] = '\0';
            }
            ESP_LOGI(TAG, "RX %u bytes, RSSI %.1f dBm, SNR %.1f dB: %.*s", (unsigned)len, s_radio->getRSSI(),
                     s_radio->getSNR(), (int)len, (const char *)buf);
            char line[320];
            const int n = snprintf(line, sizeof(line), "RX %u bytes RSSI %.1f SNR %.1f: %.*s\n", (unsigned)len,
                                   (double)s_radio->getRSSI(), (double)s_radio->getSNR(), (int)len, (const char *)buf);
            if (n > 0) {
                ble_sen0140_lora_line_notify((const uint8_t *)line, (size_t)n);
            }
        } else if (state != RADIOLIB_ERR_RX_TIMEOUT && state != RADIOLIB_ERR_CRC_MISMATCH) {
            ESP_LOGW(TAG, "readData failed: %d", state);
        }

        const int rx = s_radio->startReceive();
        if (rx != RADIOLIB_ERR_NONE) {
            ESP_LOGW(TAG, "startReceive failed: %d", rx);
            vTaskDelay(pdMS_TO_TICKS(250));
        }
    }
}

extern "C" esp_err_t sx1262_lora_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_hal = new EspHal((int8_t)SX1262_SPI_SCLK_GPIO, (int8_t)SX1262_SPI_MISO_GPIO, (int8_t)SX1262_SPI_MOSI_GPIO,
                       sx1262_spi_host(), (uint32_t)SX1262_SPI_FREQ_HZ);

    s_module = new Module(s_hal, (uint32_t)SX1262_SPI_CS_GPIO, (uint32_t)SX1262_DIO1_GPIO,
                          (uint32_t)sx1262_kconfig_gpio(SX1262_RESET_GPIO),
                          (uint32_t)sx1262_kconfig_gpio(SX1262_BUSY_GPIO));
    s_radio = new SX1262(s_module);

    const float freq_mhz = (float)SX1262_FREQ_HZ / 1000000.0f;
    /* tcxoVoltage=0: most SX1262 breakouts use a crystal on XTAL, not TCXO on DIO3. */
    const int state = s_radio->begin(freq_mhz, kLoRaBwKhz, kLoRaSf, kLoRaCr, RADIOLIB_SX126X_SYNC_WORD_PRIVATE,
                                     (int8_t)SX1262_TX_POWER_DBM, 8, 0.0f, false);
    if (state != RADIOLIB_ERR_NONE) {
        ESP_LOGE(TAG, "SX1262 begin failed: %d", state);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG,
             "SX1262 ready: SPI%d MOSI=%d MISO=%d SCK=%d CS=%d RST=%d DIO1=%d BUSY=%d freq=%.3f MHz bw=%.0f sf=%u cr=%u tx=%d dBm",
             CONFIG_SX1262_SPI_HOST_NUM, SX1262_SPI_MOSI_GPIO, SX1262_SPI_MISO_GPIO, SX1262_SPI_SCLK_GPIO,
             SX1262_SPI_CS_GPIO, SX1262_RESET_GPIO, SX1262_DIO1_GPIO, SX1262_BUSY_GPIO, (double)freq_mhz,
             (double)kLoRaBwKhz, (unsigned)kLoRaSf, (unsigned)kLoRaCr, SX1262_TX_POWER_DBM);

    s_ready = true;
    return ESP_OK;
}

extern "C" esp_err_t sx1262_lora_start(void)
{
    if (!s_ready || s_radio == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }

    const int state = s_radio->startReceive();
    if (state != RADIOLIB_ERR_NONE) {
        ESP_LOGE(TAG, "startReceive failed: %d", state);
        return ESP_FAIL;
    }

    if (xTaskCreate(sx1262_rx_task, "sx1262_rx", 4096, nullptr, 5, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "RX task create failed");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "LoRa RX task started");
    return ESP_OK;
}

extern "C" esp_err_t sx1262_lora_transmit(const uint8_t *data, size_t len)
{
    if (!s_ready || s_radio == nullptr || data == nullptr || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    const int state = s_radio->transmit(data, len);
    if (state != RADIOLIB_ERR_NONE) {
        ESP_LOGW(TAG, "transmit failed: %d", state);
        return ESP_FAIL;
    }

    const int rx = s_radio->startReceive();
    if (rx != RADIOLIB_ERR_NONE) {
        ESP_LOGW(TAG, "startReceive after TX failed: %d", rx);
    }
    return ESP_OK;
}

#else /* !CONFIG_REGATTAONE_SX1262_ENABLE */

extern "C" esp_err_t sx1262_lora_init(void) { return ESP_ERR_NOT_SUPPORTED; }

extern "C" esp_err_t sx1262_lora_start(void) { return ESP_ERR_NOT_SUPPORTED; }

extern "C" esp_err_t sx1262_lora_transmit(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */
