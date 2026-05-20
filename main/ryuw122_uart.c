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
#define RYUW_IDLE_FLUSH_READS 2

static int s_uart_baud;

static void ryuw122_emit_line(char *line, size_t *li)
{
    if (*li == 0U) {
        return;
    }
    line[*li] = '\0';
    ESP_LOGI(TAG, "RX: %s", line);
    ble_sen0140_uwb_line_notify((const uint8_t *)line, *li);
    *li = 0;
}

static bool ryuw122_probe_baud(int baud)
{
    if (uart_set_baudrate(CONFIG_RYUW122_UART_PORT_NUM, baud) != ESP_OK) {
        return false;
    }
    uart_flush(CONFIG_RYUW122_UART_PORT_NUM);
    uart_flush_input(CONFIG_RYUW122_UART_PORT_NUM);
    static const char at[] = "AT\r\n";
    if (uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, at, sizeof(at) - 1U) < 0) {
        return false;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(300));

    uint8_t buf[128];
    const int len = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(600));
    if (len <= 0) {
        ESP_LOGI(TAG, "AT probe @ %d: no bytes", baud);
        return false;
    }
    ESP_LOGI(TAG, "AT probe @ %d: %d byte(s)", baud, len);
    ESP_LOG_BUFFER_HEXDUMP(TAG, buf, (size_t)len, ESP_LOG_INFO);
    return true;
}

static void ryuw122_task(void *arg)
{
    (void)arg;
    uint8_t raw[1];
    char line[RYUW_BUF];
    size_t li = 0;
    unsigned idle_reads = 0;

    for (;;) {
        int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, raw, 1, pdMS_TO_TICKS(80));
        if (n <= 0) {
            if (li > 0U) {
                idle_reads++;
                if (idle_reads >= RYUW_IDLE_FLUSH_READS) {
                    ryuw122_emit_line(line, &li);
                    idle_reads = 0;
                }
            }
            continue;
        }
        idle_reads = 0;
        char c = (char)raw[0];
        if (c == '\r' || c == '\n') {
            ryuw122_emit_line(line, &li);
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
    const int rx = 2048;
    const int tx = 512;
    esp_err_t err = uart_driver_install(CONFIG_RYUW122_UART_PORT_NUM, rx, tx, 0, NULL, 0);
    if (err == ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "UART%d in use — use UART1 on D2/D3, not UART0 (D6/D7 = USB)", CONFIG_RYUW122_UART_PORT_NUM);
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
    ESP_RETURN_ON_ERROR(
        uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO,
                     UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE),
        TAG, "set_pin");

    ESP_LOGI(TAG, "UART%d: ESP TX=GPIO%d (→module RX), ESP RX=GPIO%d (←module TX)", CONFIG_RYUW122_UART_PORT_NUM,
             CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO);

    s_uart_baud = CONFIG_RYUW122_UART_BAUD;
    if (ryuw122_probe_baud(9600)) {
        s_uart_baud = 9600;
    } else if (ryuw122_probe_baud(115200)) {
        s_uart_baud = 115200;
    } else {
        ESP_LOGW(TAG, "No AT reply at 9600/115200 — check D3→module RX, D2←module TX, 3V3, GND; try swapping TX/RX");
        (void)uart_set_baudrate(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_BAUD);
    }

    const uint32_t stack = 4096;
    if (xTaskCreate(ryuw122_task, "ryuw122", stack, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "UART%d running at %d baud", CONFIG_RYUW122_UART_PORT_NUM, s_uart_baud);
    return ESP_OK;
}

esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    const int n = uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, (const char *)data, len);
    if (n < 0 || (size_t)n != len) {
        ESP_LOGW(TAG, "uart_write %u bytes → %d", (unsigned)len, n);
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(100));
    ESP_LOGI(TAG, "TX %.*s", (int)len, (const char *)data);
    return ESP_OK;
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

#endif
