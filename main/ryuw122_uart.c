#include "ryuw122_uart.h"

#include "sdkconfig.h"

#include <stdio.h>

#if CONFIG_REGATTAONE_RYUW122_ENABLE

#include "ble_sen0140.h"
#include "tdma.h"

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "ryuw122";

#define RYUW_RX_BUF 2048
#define RYUW_TX_BUF 512
#define RYUW_READ_CHUNK 64
#define RYUW_LINE_MAX 256

static SemaphoreHandle_t s_uart_mtx;

static void ryuw122_apply_pins(void)
{
    (void)uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO,
                       CONFIG_RYUW122_UART_RX_GPIO, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (CONFIG_RYUW122_UART_RX_GPIO >= 0) {
        gpio_set_pull_mode((gpio_num_t)CONFIG_RYUW122_UART_RX_GPIO, GPIO_PULLUP_ONLY);
    }
}

static bool ryuw122_byte_is_printable(uint8_t b)
{
    return b == '\t' || (b >= 0x20U && b <= 0x7eU);
}

static void ryuw122_log_rx_line(const char *line, size_t len)
{
    char formatted[RYUW_LINE_MAX * 4 + 1];
    size_t pos = 0;

    for (size_t i = 0; i < len && pos + 1U < sizeof(formatted); i++) {
        const uint8_t b = (uint8_t)line[i];
        if (ryuw122_byte_is_printable(b)) {
            formatted[pos++] = (char)b;
            continue;
        }
        if (pos + 5U >= sizeof(formatted)) {
            break;
        }
        pos += (size_t)snprintf(formatted + pos, sizeof(formatted) - pos, "\\x%02x", b);
    }
    formatted[pos] = '\0';
    ESP_LOGI(TAG, "RX: %s", formatted);
}

static void ryuw122_emit_line(char *line, size_t len)
{
    if (len == 0U) {
        return;
    }
    line[len] = '\0';
    ryuw122_log_rx_line(line, len);
    ble_sen0140_uwb_line_notify((const uint8_t *)line, len);
}

static void ryuw122_task(void *arg)
{
    (void)arg;
    uint8_t buf[RYUW_READ_CHUNK];
    char line[RYUW_LINE_MAX];
    size_t li = 0;

    for (;;) {
        const int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(50));
        if (n <= 0) {
            continue;
        }
        for (int i = 0; i < n; i++) {
            const char c = (char)buf[i];
            if (c == '\r' || c == '\n') {
                if (li > 0U) {
                    ryuw122_emit_line(line, li);
                    li = 0;
                }
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
}

esp_err_t ryuw122_uart_start(void)
{
    esp_err_t err = uart_driver_install(CONFIG_RYUW122_UART_PORT_NUM, RYUW_RX_BUF, RYUW_TX_BUF, 0, NULL, 0);
    if (err == ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "UART%d already in use", CONFIG_RYUW122_UART_PORT_NUM);
        return err;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "install");

    uart_config_t cfg = {
        .baud_rate = CONFIG_RYUW122_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_RETURN_ON_ERROR(uart_param_config(CONFIG_RYUW122_UART_PORT_NUM, &cfg), TAG, "param");
    ryuw122_apply_pins();

    s_uart_mtx = xSemaphoreCreateMutex();
    if (s_uart_mtx == NULL) {
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_ERR_NO_MEM;
    }

    if (CONFIG_RYUW122_BOOT_DELAY_MS > 0) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_RYUW122_BOOT_DELAY_MS));
    }

    ESP_LOGI(TAG, "creating ryuw122 task (stack=4096 pri=5, free heap=%lu)",
             (unsigned long)esp_get_free_heap_size());
    if (xTaskCreate(ryuw122_task, "ryuw122", 4096, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "ryuw122 task create failed (free heap=%lu)",
                 (unsigned long)esp_get_free_heap_size());
        vSemaphoreDelete(s_uart_mtx);
        s_uart_mtx = NULL;
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "ryuw122 task running");

    ESP_LOGI(TAG, "UART%d active: TX=GPIO%d RX=GPIO%d @ %d baud", CONFIG_RYUW122_UART_PORT_NUM,
             CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_BAUD);
    return ESP_OK;
}

esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_uart_mtx == NULL || xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const int n = uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, (const char *)data, len);
    if (n < 0 || (size_t)n != len) {
        ESP_LOGW(TAG, "uart_write %u bytes → %d", (unsigned)len, n);
        xSemaphoreGive(s_uart_mtx);
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(500));
    ESP_LOGI(TAG, "TX %.*s", (int)len, (const char *)data);
    xSemaphoreGive(s_uart_mtx);
    return ESP_OK;
}

bool ryuw122_tdma_can_use_now(void)
{
#if CONFIG_REGATTAONE_TDMA_ENABLE && CONFIG_TDMA_ENFORCE_UWB
    return tdma_can_transmit_now();
#else
    return true;
#endif
}

int64_t ryuw122_tdma_us_until_window(void)
{
#if CONFIG_REGATTAONE_TDMA_ENABLE
    return tdma_us_until_tx_window();
#else
    return 0;
#endif
}

#else

esp_err_t ryuw122_uart_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

bool ryuw122_tdma_can_use_now(void)
{
    return true;
}

int64_t ryuw122_tdma_us_until_window(void)
{
    return 0;
}

#endif
