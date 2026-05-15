#include "ryuw122_uart.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_RYUW122_ENABLE
#include "driver/uart.h"

#include "ble_sen0140.h"

static const char *TAG = "ryuw122";

#define RYUW_BUF 256

static void ryuw122_task(void *arg)
{
    (void)arg;
    uint8_t raw[1];
    char line[RYUW_BUF];
    size_t li = 0;

    for (;;) {
        int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, raw, 1, pdMS_TO_TICKS(80));
        if (n <= 0) {
            continue;
        }
        char c = (char)raw[0];
        if (c == '\r') {
            continue;
        }
        if (c == '\n') {
            line[li] = '\0';
            if (li > 0U) {
                ble_sen0140_uwb_line_notify((const uint8_t *)line, li);
            }
            li = 0;
            continue;
        }
        if (li < sizeof(line) - 1U) {
            line[li++] = c;
        } else {
            ESP_LOGW(TAG, "line overflow, discarding");
            li = 0;
        }
    }
}

esp_err_t ryuw122_uart_start(void)
{
    uart_config_t cfg = {
        .baud_rate = CONFIG_RYUW122_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_RETURN_ON_ERROR(uart_param_config(CONFIG_RYUW122_UART_PORT_NUM, &cfg), TAG, "param");
    ESP_RETURN_ON_ERROR(
        uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO,
                     UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE),
        TAG, "set_pin");
    const int rx = 2048;
    const int tx = 0;
    ESP_RETURN_ON_ERROR(uart_driver_install(CONFIG_RYUW122_UART_PORT_NUM, rx, tx, 0, NULL, 0), TAG, "install");

    const uint32_t stack = 4096;
    if (xTaskCreate(ryuw122_task, "ryuw122", stack, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "UART%d %d baud TX=GPIO%d RX=GPIO%d", CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_BAUD,
             CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO);
    return ESP_OK;
}

#else

esp_err_t ryuw122_uart_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
