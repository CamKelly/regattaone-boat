#include "console_ble.h"

#include "ble_sen0140.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static const char *TAG = "console_ble";

#define CONSOLE_BLE_LINE_MAX 192U
#define CONSOLE_BLE_QUEUE_LEN 48U

typedef struct {
    uint16_t len;
    char data[CONSOLE_BLE_LINE_MAX];
} console_ble_line_t;

static vprintf_like_t s_prev_vprintf;
static QueueHandle_t s_queue;
static TaskHandle_t s_drain_task;
static bool s_started;

static int console_ble_vprintf(const char *fmt, va_list args)
{
    if (fmt == NULL) {
        return 0;
    }

    /* Format a copy for BLE before the original vprintf consumes args. */
    if (s_queue != NULL && xTaskGetCurrentTaskHandle() != s_drain_task) {
        console_ble_line_t line;
        memset(&line, 0, sizeof(line));
        va_list copy;
        va_copy(copy, args);
        const int n = vsnprintf(line.data, sizeof(line.data), fmt, copy);
        va_end(copy);
        if (n > 0) {
            size_t len = (size_t)n;
            if (len >= sizeof(line.data)) {
                len = sizeof(line.data) - 1U;
            }
            /* Ensure a trailing newline so the web UI can reassemble cleanly. */
            if (line.data[len - 1U] != '\n' && len + 1U < sizeof(line.data)) {
                line.data[len++] = '\n';
                line.data[len] = '\0';
            }
            line.len = (uint16_t)len;
            (void)xQueueSend(s_queue, &line, 0);
        }
    }

    if (s_prev_vprintf != NULL) {
        return s_prev_vprintf(fmt, args);
    }
    return vprintf(fmt, args);
}

static void console_ble_drain_task(void *arg)
{
    (void)arg;
    console_ble_line_t line;
    for (;;) {
        if (xQueueReceive(s_queue, &line, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        if (line.len == 0U) {
            continue;
        }
        ble_sen0140_console_line_notify((const uint8_t *)line.data, (size_t)line.len);
    }
}

esp_err_t console_ble_start(void)
{
    if (s_started) {
        return ESP_OK;
    }

    s_queue = xQueueCreate(CONSOLE_BLE_QUEUE_LEN, sizeof(console_ble_line_t));
    if (s_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    BaseType_t ok = xTaskCreate(console_ble_drain_task, "console_ble", 3072, NULL, 5, &s_drain_task);
    if (ok != pdPASS) {
        vQueueDelete(s_queue);
        s_queue = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_prev_vprintf = esp_log_set_vprintf(console_ble_vprintf);
    s_started = true;
    ESP_LOGI(TAG, "mirroring ESP_LOG to BLE 0xFEE8 (UART console still active)");
    return ESP_OK;
}
