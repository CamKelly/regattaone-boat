#include "gps_pps.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_GPS_ENABLE && CONFIG_GPS_PPS_GPIO >= 0

#include "ble_sen0140.h"

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "gps_pps";

#define GPS_PPS_LINE_MAX 96

static portMUX_TYPE s_pps_lock = portMUX_INITIALIZER_UNLOCKED;
static volatile int64_t s_last_edge_us;
static volatile int64_t s_cap_delta_us;
static volatile uint32_t s_pulse_count;
static TaskHandle_t s_notify_task;

static void IRAM_ATTR gps_pps_isr(void *arg)
{
    (void)arg;
    const int64_t now = esp_timer_get_time();

    portENTER_CRITICAL_ISR(&s_pps_lock);
    const int64_t prev = s_last_edge_us;
    s_last_edge_us = now;
    if (prev > 0) {
        s_cap_delta_us = now - prev;
    }
    s_pulse_count++;
    portEXIT_CRITICAL_ISR(&s_pps_lock);

    BaseType_t hp = pdFALSE;
    if (s_notify_task != NULL) {
        vTaskNotifyGiveFromISR(s_notify_task, &hp);
        if (hp) {
            portYIELD_FROM_ISR();
        }
    }
}

static void gps_pps_notify_task(void *arg)
{
    (void)arg;
    char line[GPS_PPS_LINE_MAX];

    for (;;) {
        (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        int64_t mono_us;
        int64_t delta_us;
        uint32_t count;
        portENTER_CRITICAL(&s_pps_lock);
        mono_us = s_last_edge_us;
        delta_us = s_cap_delta_us;
        count = s_pulse_count;
        portEXIT_CRITICAL(&s_pps_lock);

        const int n = snprintf(line, sizeof(line), "$PREGPPS,%lld,%lu,,%lld,%lld\n",
                               (long long)mono_us, (unsigned long)count, (long long)mono_us,
                               (long long)delta_us);
        if (n <= 0 || (size_t)n >= sizeof(line)) {
            continue;
        }

        ble_sen0140_gps_line_notify((const uint8_t *)line, (size_t)n);

        if (count <= 3U || (count % 60U) == 0U) {
            ESP_LOGI(TAG, "PPS #%lu delta=%lld us GPIO%d", (unsigned long)count, (long long)delta_us,
                     CONFIG_GPS_PPS_GPIO);
        }
    }
}

esp_err_t gps_pps_start(void)
{
    const gpio_num_t pin = (gpio_num_t)CONFIG_GPS_PPS_GPIO;

    s_last_edge_us = 0;
    s_cap_delta_us = 0;
    s_pulse_count = 0;

    if (s_notify_task == NULL) {
        if (xTaskCreate(gps_pps_notify_task, "gps_pps", 3072, NULL, 6, &s_notify_task) != pdPASS) {
            return ESP_FAIL;
        }
    }

    /* LoRa HAL (or another driver) may already have installed the GPIO ISR service. */
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << pin,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_POSEDGE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "gpio config");

    ESP_RETURN_ON_ERROR(gpio_isr_handler_add(pin, gps_pps_isr, NULL), TAG, "isr add");

    ESP_LOGI(TAG, "PPS capture on GPIO%d → BLE $PREGPPS", CONFIG_GPS_PPS_GPIO);
    return ESP_OK;
}

#else

esp_err_t gps_pps_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
