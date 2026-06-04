#include "gps_nmea.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_GPS_ENABLE
#include "driver/gpio.h"
#include "driver/uart.h"

#include "ble_sen0140.h"

static const char *TAG = "gps";

#define GPS_LINE_MAX 256

static TaskHandle_t s_gps_task;
static volatile uint32_t s_pps_count;
static volatile int64_t s_pps_last_us;

static void gps_emit_line(char *line, size_t *li)
{
    if (*li == 0U) {
        return;
    }
    if (*li + 1U >= GPS_LINE_MAX) {
        ESP_LOGW(TAG, "NMEA line overflow, discarding");
        *li = 0;
        return;
    }
    line[*li] = '\n';
    const size_t n = *li + 1U;
    line[n] = '\0';
    ble_sen0140_gps_line_notify((const uint8_t *)line, n);
    *li = 0;
}

static void gps_emit_pps_ble(void)
{
    char line[72];
    const int64_t us = s_pps_last_us;
    const uint32_t count = s_pps_count;
    const int n = snprintf(line, sizeof(line), "$PREGPPS,%lld,%lu\n", (long long)us, (unsigned long)count);
    if (n > 0 && (size_t)n < sizeof(line)) {
        ble_sen0140_gps_line_notify((const uint8_t *)line, (size_t)n);
    }
}

static void IRAM_ATTR gps_pps_isr(void *arg)
{
    (void)arg;
    s_pps_count++;
    s_pps_last_us = esp_timer_get_time();
    BaseType_t woken = pdFALSE;
    if (s_gps_task != NULL) {
        vTaskNotifyGiveFromISR(s_gps_task, &woken);
    }
    portYIELD_FROM_ISR(woken);
}

static esp_err_t gps_pps_init(void)
{
#if GPS_PPS_GPIO < 0
    ESP_LOGI(TAG, "PPS disabled (GPS_PPS_GPIO=-1)");
    return ESP_OK;
#else
    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "gpio isr service: %s", esp_err_to_name(err));
        return err;
    }

    gpio_config_t io = {
        .pin_bit_mask = 1ULL << GPS_PPS_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_POSEDGE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "pps gpio_config");

    err = gpio_isr_handler_add((gpio_num_t)GPS_PPS_GPIO, gps_pps_isr, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "pps isr add GPIO%d: %s", GPS_PPS_GPIO, esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "PPS input on GPIO%d (rising edge → BLE $PREGPPS)", GPS_PPS_GPIO);
    return ESP_OK;
#endif
}

static void gps_uart_task(void *arg)
{
    (void)arg;
    uint8_t byte;
    char line[GPS_LINE_MAX];
    size_t li = 0;

    for (;;) {
        uint32_t notify = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(0));
        if (notify > 0U) {
            gps_emit_pps_ble();
        }

        const int n = uart_read_bytes(GPS_UART_PORT_NUM, &byte, 1, pdMS_TO_TICKS(50));
        if (n <= 0) {
            continue;
        }
        if (byte == '\r') {
            continue;
        }
        if (byte == '\n') {
            gps_emit_line(line, &li);
            continue;
        }
        if (li + 1U < GPS_LINE_MAX) {
            line[li++] = (char)byte;
        } else {
            ESP_LOGW(TAG, "NMEA line overflow, discarding");
            li = 0;
        }
    }
}

esp_err_t gps_nmea_start(void)
{
    const int rx = 2048;
    const int tx = 256;
    esp_err_t err = uart_driver_install(GPS_UART_PORT_NUM, rx, tx, 0, NULL, 0);
    if (err == ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "UART%d in use", GPS_UART_PORT_NUM);
        return err;
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "uart_driver_install: %s", esp_err_to_name(err));
        return err;
    }

    uart_config_t cfg = {
        .baud_rate = GPS_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_param_config(GPS_UART_PORT_NUM, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(GPS_UART_PORT_NUM, GPS_UART_TX_GPIO, GPS_UART_RX_GPIO, UART_PIN_NO_CHANGE,
                                 UART_PIN_NO_CHANGE));

    ESP_LOGI(TAG, "UART%d: TX=GPIO%d RX=GPIO%d @ %d baud (NMEA → BLE only, not serial log)",
             GPS_UART_PORT_NUM, GPS_UART_TX_GPIO, GPS_UART_RX_GPIO, GPS_UART_BAUD);

    err = gps_pps_init();
    if (err != ESP_OK) {
        uart_driver_delete(GPS_UART_PORT_NUM);
        return err;
    }

    const uint32_t stack = 4096;
    if (xTaskCreate(gps_uart_task, "gps_nmea", stack, NULL, 5, &s_gps_task) != pdPASS) {
        s_gps_task = NULL;
        uart_driver_delete(GPS_UART_PORT_NUM);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

uint32_t gps_pps_pulse_count(void)
{
    return s_pps_count;
}

int64_t gps_pps_last_edge_us(void)
{
    return s_pps_last_us;
}

#else /* !CONFIG_REGATTAONE_GPS_ENABLE */

uint32_t gps_pps_pulse_count(void)
{
    return 0U;
}

int64_t gps_pps_last_edge_us(void)
{
    return 0;
}

esp_err_t gps_nmea_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_GPS_ENABLE */
