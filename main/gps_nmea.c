#include "gps_nmea.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_GPS_ENABLE
#include "driver/uart.h"

#include "ble_sen0140.h"

static const char *TAG = "gps";

#define GPS_LINE_MAX 256

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
    ESP_LOGI(TAG, "RX: %.*s", (int)(n - 1U), line);
    ble_sen0140_gps_line_notify((const uint8_t *)line, n);
    *li = 0;
}

static void gps_uart_task(void *arg)
{
    (void)arg;
    uint8_t byte;
    char line[GPS_LINE_MAX];
    size_t li = 0;

    for (;;) {
        const int n = uart_read_bytes(GPS_UART_PORT_NUM, &byte, 1, pdMS_TO_TICKS(100));
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

    ESP_LOGI(TAG, "UART%d: TX=GPIO%d RX=GPIO%d @ %d baud", GPS_UART_PORT_NUM, GPS_UART_TX_GPIO, GPS_UART_RX_GPIO,
             GPS_UART_BAUD);

    if (xTaskCreate(gps_uart_task, "gps_nmea", 4096, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(GPS_UART_PORT_NUM);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

#else /* !CONFIG_REGATTAONE_GPS_ENABLE */

esp_err_t gps_nmea_start(void) { return ESP_ERR_NOT_SUPPORTED; }

#endif /* CONFIG_REGATTAONE_GPS_ENABLE */
