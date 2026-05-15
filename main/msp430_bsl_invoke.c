/*
 * MSP430 FRAM BSL hardware invocation (SLAU550 §3.3.2, Figure 3-2).
 */
#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "msp430_bsl_invoke.h"

static const char *TAG = "msp430_bsl";

static bool s_ready;

static inline gpio_num_t rst_pin(void)
{
    return (gpio_num_t)MSP430_BSL_RST_GPIO_NUM;
}

static inline gpio_num_t test_pin(void)
{
    return (gpio_num_t)MSP430_BSL_TEST_GPIO_NUM;
}

static inline bool pins_configured(void)
{
    return MSP430_BSL_RST_GPIO_NUM >= 0 && MSP430_BSL_TEST_GPIO_NUM >= 0;
}

esp_err_t msp430_bsl_gpio_init(void)
{
    s_ready = false;
    if (!pins_configured()) {
        ESP_LOGW(TAG, "BSL GPIO disabled (set MSP430_BSL_RST_GPIO_NUM / TEST to NC=-1)");
        return ESP_OK;
    }

    gpio_config_t io = {
        .pin_bit_mask = (1ULL << (unsigned)rst_pin()) | (1ULL << (unsigned)test_pin()),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_config %s", esp_err_to_name(err));
        return err;
    }

    gpio_set_level(rst_pin(), 1);
    gpio_set_level(test_pin(), 0);
    s_ready = true;
    ESP_LOGI(TAG, "BSL invoke: RST GPIO%d  TEST GPIO%d", MSP430_BSL_RST_GPIO_NUM, MSP430_BSL_TEST_GPIO_NUM);
    return ESP_OK;
}

bool msp430_bsl_invoke_ready(void)
{
    return s_ready;
}

esp_err_t msp430_bsl_invoke_hardware(void)
{
    if (!s_ready || !pins_configured()) {
        return ESP_ERR_NOT_SUPPORTED;
    }

    /*
     * SLAU550 Figure 3-2: RST low while TEST receives ≥2 rising edges; TEST high when RST releases.
     * Conservative 20 ms edges / 50 ms after RST / 250 ms settle — robust on breadboards vs 2 ms ticks.
     */
    const TickType_t edge_ms = pdMS_TO_TICKS(20);

    gpio_set_level(rst_pin(), 0);
    gpio_set_level(test_pin(), 0);
    vTaskDelay(pdMS_TO_TICKS(20));

    gpio_set_level(test_pin(), 1);
    vTaskDelay(edge_ms);
    gpio_set_level(test_pin(), 0);
    vTaskDelay(edge_ms);
    gpio_set_level(test_pin(), 1);
    vTaskDelay(edge_ms);

    gpio_set_level(rst_pin(), 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    gpio_set_level(test_pin(), 0);
    vTaskDelay(pdMS_TO_TICKS(250));

    ESP_LOGI(TAG, "BSL entry sequence completed");
    return ESP_OK;
}

esp_err_t msp430_bsl_gpio_manual_levels(bool rst_high, bool test_high)
{
    if (!s_ready || !pins_configured()) {
        return ESP_ERR_NOT_SUPPORTED;
    }
    gpio_set_level(rst_pin(), rst_high ? 1 : 0);
    gpio_set_level(test_pin(), test_high ? 1 : 0);
    ESP_LOGI(TAG, "GPIO manual: RST=%s TEST=%s", rst_high ? "H" : "L", test_high ? "H" : "L");
    return ESP_OK;
}

esp_err_t msp430_bsl_gpio_idle_levels(void)
{
    return msp430_bsl_gpio_manual_levels(true, false);
}
