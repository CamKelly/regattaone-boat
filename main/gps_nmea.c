#include "gps_nmea.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_GPS_ENABLE

#include "ble_sen0140.h"

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "gps_nmea";

#define GPS_RX_BUF 2048
#define GPS_TX_BUF 256
#define GPS_READ_CHUNK 256
#define GPS_LINE_MAX 128

static void gps_apply_pins(void)
{
    (void)uart_set_pin(CONFIG_GPS_UART_PORT_NUM, CONFIG_GPS_UART_TX_GPIO, CONFIG_GPS_UART_RX_GPIO,
                       UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (CONFIG_GPS_UART_RX_GPIO >= 0) {
        gpio_set_pull_mode((gpio_num_t)CONFIG_GPS_UART_RX_GPIO, GPIO_PULLUP_ONLY);
    }
}

static void gps_emit_line(char *line, size_t len)
{
    if (len == 0U) {
        return;
    }
    if (line[len - 1U] != '\n') {
        if (len + 1U >= GPS_LINE_MAX) {
            return;
        }
        line[len++] = '\n';
    }
    static uint32_t s_nmea_logged;
    if (s_nmea_logged < 3U) {
        size_t show = len;
        if (show > 0U && line[show - 1U] == '\n') {
            show--;
        }
        if (show > 72U) {
            show = 72U;
        }
        ESP_LOGI(TAG, "NMEA #%lu: %.*s", (unsigned long)(s_nmea_logged + 1U), (int)show, line);
        s_nmea_logged++;
    }
    ble_sen0140_gps_line_notify((const uint8_t *)line, len);
}

static void gps_task(void *arg)
{
    (void)arg;
    uint8_t buf[GPS_READ_CHUNK];
    char line[GPS_LINE_MAX];
    size_t li = 0;

    for (;;) {
        const int n = uart_read_bytes(CONFIG_GPS_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(50));
        if (n <= 0) {
            continue;
        }
        for (int i = 0; i < n; i++) {
            const char c = (char)buf[i];
            if (c == '\r') {
                continue;
            }
            if (c == '\n') {
                if (li > 0U) {
                    gps_emit_line(line, li);
                    li = 0U;
                }
                continue;
            }
            if (li + 1U >= GPS_LINE_MAX) {
                li = 0U;
                continue;
            }
            line[li++] = c;
        }
    }
}

esp_err_t gps_nmea_start(void)
{
    esp_err_t err = uart_driver_install(CONFIG_GPS_UART_PORT_NUM, GPS_RX_BUF, GPS_TX_BUF, 0, NULL, 0);
    if (err == ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "UART%d already in use", CONFIG_GPS_UART_PORT_NUM);
        return err;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "install");

    uart_config_t cfg = {
        .baud_rate = CONFIG_GPS_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_RETURN_ON_ERROR(uart_param_config(CONFIG_GPS_UART_PORT_NUM, &cfg), TAG, "param");
    gps_apply_pins();
    uart_flush(CONFIG_GPS_UART_PORT_NUM);
    uart_flush_input(CONFIG_GPS_UART_PORT_NUM);

    if (CONFIG_GPS_BOOT_DELAY_MS > 0) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_GPS_BOOT_DELAY_MS));
    }

    if (xTaskCreate(gps_task, "gps_nmea", 4096, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(CONFIG_GPS_UART_PORT_NUM);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "UART%d active: TX=GPIO%d RX=GPIO%d @ %d baud (NMEA → BLE 0xFEFD)",
             CONFIG_GPS_UART_PORT_NUM, CONFIG_GPS_UART_TX_GPIO, CONFIG_GPS_UART_RX_GPIO, CONFIG_GPS_UART_BAUD);
    return ESP_OK;
}

#else

esp_err_t gps_nmea_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_GPS_ENABLE */
