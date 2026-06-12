#include "meshtastic_uart.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE

#include "meshtastic_client.h"

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "meshtastic";

#define MESHTASTIC_RX_BUF 2048
#define MESHTASTIC_TX_BUF 1024
#define MESHTASTIC_READ_CHUNK 256

static SemaphoreHandle_t s_uart_mtx;

static void meshtastic_apply_pins(void)
{
    (void)uart_set_pin(CONFIG_MESHTASTIC_UART_PORT_NUM, CONFIG_MESHTASTIC_UART_TX_GPIO,
                       CONFIG_MESHTASTIC_UART_RX_GPIO, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (CONFIG_MESHTASTIC_UART_RX_GPIO >= 0) {
        gpio_set_pull_mode((gpio_num_t)CONFIG_MESHTASTIC_UART_RX_GPIO, GPIO_PULLUP_ONLY);
    }
}

static void meshtastic_task(void *arg)
{
    (void)arg;
    uint8_t buf[MESHTASTIC_READ_CHUNK];

    for (;;) {
        const int n = uart_read_bytes(CONFIG_MESHTASTIC_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(50));
        if (n <= 0) {
            continue;
        }
        meshtastic_client_uart_rx(buf, (size_t)n);
    }
}

esp_err_t meshtastic_uart_start(void)
{
    esp_err_t err = uart_driver_install(CONFIG_MESHTASTIC_UART_PORT_NUM, MESHTASTIC_RX_BUF, MESHTASTIC_TX_BUF, 0, NULL,
                                        0);
    if (err == ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "UART%d already in use", CONFIG_MESHTASTIC_UART_PORT_NUM);
        return err;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "install");

    uart_config_t cfg = {
        .baud_rate = CONFIG_MESHTASTIC_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_RETURN_ON_ERROR(uart_param_config(CONFIG_MESHTASTIC_UART_PORT_NUM, &cfg), TAG, "param");
    meshtastic_apply_pins();

    s_uart_mtx = xSemaphoreCreateMutex();
    if (s_uart_mtx == NULL) {
        uart_driver_delete(CONFIG_MESHTASTIC_UART_PORT_NUM);
        return ESP_ERR_NO_MEM;
    }

    if (CONFIG_MESHTASTIC_BOOT_DELAY_MS > 0) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_MESHTASTIC_BOOT_DELAY_MS));
    }

    if (xTaskCreate(meshtastic_task, "meshtastic", 4096, NULL, 5, NULL) != pdPASS) {
        vSemaphoreDelete(s_uart_mtx);
        s_uart_mtx = NULL;
        uart_driver_delete(CONFIG_MESHTASTIC_UART_PORT_NUM);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "UART%d active: TX=GPIO%d RX=GPIO%d @ %d baud (Meshtastic PROTO)",
             CONFIG_MESHTASTIC_UART_PORT_NUM, CONFIG_MESHTASTIC_UART_TX_GPIO, CONFIG_MESHTASTIC_UART_RX_GPIO,
             CONFIG_MESHTASTIC_UART_BAUD);

    err = meshtastic_client_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Meshtastic client start: %s", esp_err_to_name(err));
    }
    return ESP_OK;
}

esp_err_t meshtastic_uart_write(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_uart_mtx == NULL || xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const int n = uart_write_bytes(CONFIG_MESHTASTIC_UART_PORT_NUM, (const char *)data, len);
    if (n < 0 || (size_t)n != len) {
        ESP_LOGW(TAG, "uart_write %u bytes → %d", (unsigned)len, n);
        xSemaphoreGive(s_uart_mtx);
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(CONFIG_MESHTASTIC_UART_PORT_NUM, pdMS_TO_TICKS(500));
    xSemaphoreGive(s_uart_mtx);
    return ESP_OK;
}

#else

esp_err_t meshtastic_uart_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t meshtastic_uart_write(const uint8_t *data, size_t len)
{
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_MESHTASTIC_ENABLE */
