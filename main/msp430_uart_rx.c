/*
 * Receives MSP430 serial on UART1 and forwards bytes over BLE notify (see ble_sen0140_uart_notify).
 */
#include "driver/uart.h"

#include "esp_err.h"
#include "esp_log.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "ble_sen0140.h"
#include "msp430_uart_rx.h"

static const char *TAG = "msp430_uart";

static volatile bool s_bridge_enabled = true;

/**
 * ESP32-C3 (e.g. XIAO): GPIO18/19 are USB; GPIO12–17 are SPI flash — use GPIO2/3 here.
 * ESP32-S3 and others: adjust if your PCB differs.
 */
#define MSP430_UART_NUM MSP430_BRIDGE_UART_NUM
#if CONFIG_IDF_TARGET_ESP32C3
#define MSP430_UART_TX_GPIO 3
#define MSP430_UART_RX_GPIO 2
#else
#define MSP430_UART_TX_GPIO 17
#define MSP430_UART_RX_GPIO 18
#endif
#define MSP430_UART_BAUD          115200
#define MSP430_UART_RX_BUF        4096
#define MSP430_UART_TASK_STACK    4096
#define MSP430_UART_READ_CHUNK    512

static void msp430_uart_task(void *arg)
{
    (void)arg;
    uint8_t buf[MSP430_UART_READ_CHUNK];

    for (;;) {
        if (!s_bridge_enabled) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        int n = uart_read_bytes(MSP430_UART_NUM, buf, sizeof(buf), pdMS_TO_TICKS(50));
        if (n > 0) {
            ble_sen0140_uart_notify_chunk(buf, (size_t)n);
        }
    }
}

void msp430_uart_bridge_set_enabled(bool enable)
{
    s_bridge_enabled = enable;
}

esp_err_t msp430_uart_apply_config(int baud_rate, uart_parity_t parity)
{
    uart_config_t cfg = {
        .baud_rate = baud_rate,
        .data_bits = UART_DATA_8_BITS,
        .parity = parity,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .rx_flow_ctrl_thresh = 0,
        .source_clk = UART_SCLK_DEFAULT,
    };
    return uart_param_config(MSP430_UART_NUM, &cfg);
}

void msp430_uart_flush_rx(void)
{
    uart_flush_input(MSP430_UART_NUM);
}

esp_err_t msp430_uart_rx_start(void)
{
    uart_config_t cfg = {
        .baud_rate = MSP430_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .rx_flow_ctrl_thresh = 0,
        .source_clk = UART_SCLK_DEFAULT,
    };

    esp_err_t err = uart_driver_install(MSP430_UART_NUM, MSP430_UART_RX_BUF, 0, 0, NULL, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "uart_driver_install %s", esp_err_to_name(err));
        return err;
    }
    err = uart_param_config(MSP430_UART_NUM, &cfg);
    if (err != ESP_OK) {
        uart_driver_delete(MSP430_UART_NUM);
        ESP_LOGE(TAG, "uart_param_config %s", esp_err_to_name(err));
        return err;
    }
    err = uart_set_pin(MSP430_UART_NUM, MSP430_UART_TX_GPIO, MSP430_UART_RX_GPIO, UART_PIN_NO_CHANGE,
                       UART_PIN_NO_CHANGE);
    if (err != ESP_OK) {
        uart_driver_delete(MSP430_UART_NUM);
        ESP_LOGE(TAG, "uart_set_pin %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "UART1 MSP430 bridge TX GPIO%d RX GPIO%d @ %d baud", MSP430_UART_TX_GPIO,
             MSP430_UART_RX_GPIO, MSP430_UART_BAUD);

    BaseType_t ok =
        xTaskCreate(msp430_uart_task, "msp430_uart", MSP430_UART_TASK_STACK, NULL, 5, NULL);
    if (ok != pdPASS) {
        uart_driver_delete(MSP430_UART_NUM);
        ESP_LOGE(TAG, "task create failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}
