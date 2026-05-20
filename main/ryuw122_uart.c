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
/** Complete lines end in CRLF; only flush partial lines after long idle (async/spontaneous). */
#define RYUW_IDLE_FLUSH_READS 30

static int s_uart_baud;
static int s_tx_gpio;
static int s_rx_gpio;

static char s_line[RYUW_BUF];
static size_t s_li;
static portMUX_TYPE s_line_mux = portMUX_INITIALIZER_UNLOCKED;

static void ryuw122_emit_line_unlocked(void)
{
    if (s_li == 0U) {
        return;
    }
    char out[RYUW_BUF];
    memcpy(out, s_line, s_li);
    out[s_li] = '\0';
    const size_t len = s_li;
    s_li = 0;
    portEXIT_CRITICAL(&s_line_mux);

    ESP_LOGI(TAG, "RX: %s", out);
    ble_sen0140_uwb_line_notify((const uint8_t *)out, len);
}

static void ryuw122_feed_byte(char c)
{
    portENTER_CRITICAL(&s_line_mux);
    if (c == '\r' || c == '\n') {
        if (s_li > 0U) {
            ryuw122_emit_line_unlocked();
        } else {
            portEXIT_CRITICAL(&s_line_mux);
        }
        return;
    }
    if (s_li < sizeof(s_line) - 1U) {
        s_line[s_li++] = c;
    } else {
        ESP_LOGW(TAG, "line overflow, discarding");
        s_li = 0;
    }
    portEXIT_CRITICAL(&s_line_mux);
}

static void ryuw122_feed_bytes(const uint8_t *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        ryuw122_feed_byte((char)data[i]);
    }
}

static void ryuw122_drain_rx_ms(int ms)
{
    uint8_t buf[128];
    const TickType_t until = xTaskGetTickCount() + pdMS_TO_TICKS(ms);
    TickType_t last_rx = 0;

    while (xTaskGetTickCount() < until) {
        const int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(40));
        if (n > 0) {
            ryuw122_feed_bytes(buf, (size_t)n);
            last_rx = xTaskGetTickCount();
        } else if (last_rx != 0 && (xTaskGetTickCount() - last_rx) > pdMS_TO_TICKS(120)) {
            break;
        }
    }
}

static bool ryuw122_send_at_and_read(int baud, uint8_t *buf, size_t buf_len, int *out_len)
{
    if (uart_set_baudrate(CONFIG_RYUW122_UART_PORT_NUM, baud) != ESP_OK) {
        return false;
    }
    uart_flush(CONFIG_RYUW122_UART_PORT_NUM);
    uart_flush_input(CONFIG_RYUW122_UART_PORT_NUM);

    static const char at[] = "AT\r\n";
    for (int attempt = 0; attempt < 3; attempt++) {
        if (uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, at, sizeof(at) - 1U) < 0) {
            return false;
        }
        (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(300));
        vTaskDelay(pdMS_TO_TICKS(40));

        *out_len = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, buf_len, pdMS_TO_TICKS(800));
        if (*out_len > 0) {
            ryuw122_feed_bytes(buf, (size_t)*out_len);
            return true;
        }
    }
    return false;
}

static bool ryuw122_probe_pins(int tx_gpio, int rx_gpio, int baud, const char *layout_label)
{
    if (uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, tx_gpio, rx_gpio, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) !=
        ESP_OK) {
        return false;
    }

    uint8_t buf[128];
    int len = 0;
    if (!ryuw122_send_at_and_read(baud, buf, sizeof(buf), &len)) {
        return false;
    }

    s_tx_gpio = tx_gpio;
    s_rx_gpio = rx_gpio;
    s_uart_baud = baud;
    ESP_LOGI(TAG, "AT OK (%s): TX=GPIO%d RX=GPIO%d @ %d — %d byte(s)", layout_label, tx_gpio, rx_gpio, baud, len);
    return true;
}

static bool ryuw122_autoprobe(void)
{
    static const int bauds[] = {115200, 9600, 57600};
    const struct {
        int tx;
        int rx;
        const char *label;
    } layouts[] = {
        {CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO, "menuconfig"},
        {CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_TX_GPIO, "TX/RX swapped"},
    };

    for (size_t li = 0; li < sizeof(layouts) / sizeof(layouts[0]); li++) {
        for (size_t bi = 0; bi < sizeof(bauds) / sizeof(bauds[0]); bi++) {
            if (ryuw122_probe_pins(layouts[li].tx, layouts[li].rx, bauds[bi], layouts[li].label)) {
                if (li > 0U) {
                    ESP_LOGW(TAG, "Wires are crossed — use ESP TX=GPIO%d → module RXD, RX=GPIO%d ← module TXD",
                             layouts[li].tx, layouts[li].rx);
                }
                return true;
            }
        }
    }
    return false;
}

static void ryuw122_task(void *arg)
{
    (void)arg;
    uint8_t buf[64];
    unsigned idle_reads = 0;

    for (;;) {
        const int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(80));
        if (n <= 0) {
            portENTER_CRITICAL(&s_line_mux);
            const bool pending = s_li > 0U;
            portEXIT_CRITICAL(&s_line_mux);
            if (pending) {
                idle_reads++;
                if (idle_reads >= RYUW_IDLE_FLUSH_READS) {
                    portENTER_CRITICAL(&s_line_mux);
                    if (s_li > 0U) {
                        ryuw122_emit_line_unlocked();
                    } else {
                        portEXIT_CRITICAL(&s_line_mux);
                    }
                    idle_reads = 0;
                }
            }
            continue;
        }
        idle_reads = 0;
        ryuw122_feed_bytes(buf, (size_t)n);
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

    s_tx_gpio = CONFIG_RYUW122_UART_TX_GPIO;
    s_rx_gpio = CONFIG_RYUW122_UART_RX_GPIO;
    s_uart_baud = CONFIG_RYUW122_UART_BAUD;
    s_li = 0;

    ESP_LOGI(TAG, "UART%d: menuconfig TX=GPIO%d RX=GPIO%d", CONFIG_RYUW122_UART_PORT_NUM,
             CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO);

    if (CONFIG_RYUW122_BOOT_DELAY_MS > 0) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_RYUW122_BOOT_DELAY_MS));
    }

    if (!ryuw122_autoprobe()) {
        ESP_LOGW(TAG, "No AT reply at boot (UART may still work once module is up)");
        (void)uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO,
                           CONFIG_RYUW122_UART_RX_GPIO, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
        (void)uart_set_baudrate(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_BAUD);
    }

    const uint32_t stack = 4096;
    if (xTaskCreate(ryuw122_task, "ryuw122", stack, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "UART%d active: TX=GPIO%d RX=GPIO%d @ %d baud", CONFIG_RYUW122_UART_PORT_NUM, s_tx_gpio,
             s_rx_gpio, s_uart_baud);
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
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(200));
    ESP_LOGI(TAG, "TX %.*s", (int)len, (const char *)data);
    ryuw122_drain_rx_ms(900);
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
