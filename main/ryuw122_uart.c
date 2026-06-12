#include "ryuw122_uart.h"

#include <stdbool.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_RYUW122_ENABLE
#include "driver/uart.h"
#include "driver/gpio.h"

#include "ble_sen0140.h"
#include "tdma.h"

static const char *TAG = "ryuw122";

#define RYUW_BUF 256
#define RYUW_IDLE_FLUSH_READS 25
#define RYUW_AT_RSP_MAX 384

static int s_uart_baud;
static int s_tx_gpio;
static int s_rx_gpio;
static bool s_probe_ok;

/** Set after BLE/web AT write; task reads harder until line idle. */
static volatile bool s_post_tx_drain;

static SemaphoreHandle_t s_uart_mtx;
static SemaphoreHandle_t s_at_done;
static QueueHandle_t s_ble_at_q;
static char s_at_rsp[RYUW_AT_RSP_MAX];
static size_t s_at_rsp_len;
static bool s_at_ok;
static bool s_at_err;

static bool ryuw122_byte_is_printable(uint8_t b)
{
    return b == '\r' || b == '\n' || b == '\t' || (b >= 0x20U && b <= 0x7eU);
}

/** REYAX AT replies are ASCII and contain +OK or +ERR when the link is correct. */
static bool ryuw122_buf_looks_like_at_reply(const uint8_t *buf, int len)
{
    if (!buf || len <= 0) {
        return false;
    }
    int printable = 0;
    for (int i = 0; i < len; i++) {
        if (ryuw122_byte_is_printable(buf[i])) {
            printable++;
        }
    }
    if (printable * 4 < len * 3) {
        return false;
    }
    char tmp[129];
    const int n = len > 127 ? 127 : len;
    memcpy(tmp, buf, (size_t)n);
    tmp[n] = '\0';
    return strstr(tmp, "+OK") != NULL || strstr(tmp, "+ERR") != NULL || strstr(tmp, "OK") != NULL;
}

static bool ryuw122_line_is_printable(const char *line, size_t len)
{
    if (!line || len == 0U) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        if (!ryuw122_byte_is_printable((uint8_t)line[i])) {
            return false;
        }
    }
    return true;
}

static void ryuw122_apply_uart(int tx_gpio, int rx_gpio, int baud)
{
    (void)uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, tx_gpio, rx_gpio, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (rx_gpio >= 0) {
        gpio_set_pull_mode((gpio_num_t)rx_gpio, GPIO_PULLUP_ONLY);
    }
    (void)uart_set_baudrate(CONFIG_RYUW122_UART_PORT_NUM, baud);
    uart_flush(CONFIG_RYUW122_UART_PORT_NUM);
    uart_flush_input(CONFIG_RYUW122_UART_PORT_NUM);
}

static void ryuw122_at_append_line(const char *line)
{
    if (!line || s_at_done == NULL) {
        return;
    }
    if (strstr(line, "+OK") != NULL) {
        s_at_ok = true;
    }
    if (strstr(line, "+ERR") != NULL) {
        s_at_err = true;
    }
    const size_t n = strlen(line);
    if (s_at_rsp_len + n + 2U < sizeof(s_at_rsp)) {
        memcpy(s_at_rsp + s_at_rsp_len, line, n);
        s_at_rsp_len += n;
        s_at_rsp[s_at_rsp_len++] = '\n';
        s_at_rsp[s_at_rsp_len] = '\0';
    }
    if (s_at_ok || s_at_err) {
        xSemaphoreGive(s_at_done);
    }
}

static void ryuw122_emit_line(char *line, size_t *li)
{
    if (*li == 0U) {
        return;
    }
    if (!ryuw122_line_is_printable(line, *li)) {
        ESP_LOGW(TAG, "RX garbage (%u bytes) — check TX/RX swap and baud (115200 default)", (unsigned)*li);
        ESP_LOG_BUFFER_HEXDUMP(TAG, line, *li, ESP_LOG_WARN);
        *li = 0;
        return;
    }
    line[*li] = '\0';
    ESP_LOGI(TAG, "RX: %s", line);
    if (s_at_done != NULL) {
        ryuw122_at_append_line(line);
    }
    ble_sen0140_uwb_line_notify((const uint8_t *)line, *li);
    *li = 0;
}

static bool ryuw122_send_at_probe(int tx_gpio, int rx_gpio, int baud)
{
    ryuw122_apply_uart(tx_gpio, rx_gpio, baud);

    static const char at[] = "AT\r\n";
    if (uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, at, sizeof(at) - 1U) < 0) {
        return false;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(300));
    vTaskDelay(pdMS_TO_TICKS(80));

    uint8_t buf[128];
    const int len = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(1500));
    if (len <= 0 || !ryuw122_buf_looks_like_at_reply(buf, len)) {
        if (len > 0) {
            ESP_LOGD(TAG, "probe reject TX=%d RX=%d @ %d (%d bytes)", tx_gpio, rx_gpio, baud, len);
            ESP_LOG_BUFFER_HEXDUMP(TAG, buf, (size_t)len, ESP_LOG_DEBUG);
        }
        return false;
    }
    ESP_LOGI(TAG, "AT OK: TX=GPIO%d RX=GPIO%d @ %d — %.*s", tx_gpio, rx_gpio, baud, len, (const char *)buf);
    return true;
}

static bool ryuw122_autoprobe(void)
{
    static const int bauds[] = {115200, 57600, 38400, 9600};
    const struct {
        int tx;
        int rx;
    } layouts[] = {
        {CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO},
        {CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_TX_GPIO},
    };

    for (size_t li = 0; li < sizeof(layouts) / sizeof(layouts[0]); li++) {
        for (size_t bi = 0; bi < sizeof(bauds) / sizeof(bauds[0]); bi++) {
            if (ryuw122_send_at_probe(layouts[li].tx, layouts[li].rx, bauds[bi])) {
                s_tx_gpio = layouts[li].tx;
                s_rx_gpio = layouts[li].rx;
                s_uart_baud = bauds[bi];
                ryuw122_apply_uart(s_tx_gpio, s_rx_gpio, s_uart_baud);
                if (li > 0U) {
                    ESP_LOGW(TAG, "TX/RX were swapped — use ESP TX=GPIO%d, RX=GPIO%d", s_tx_gpio, s_rx_gpio);
                }
                return true;
            }
        }
    }
    return false;
}

typedef struct {
    char cmd[128];
} ryuw122_at_job_t;

static void ryuw122_ble_at_task(void *arg)
{
    (void)arg;
    ryuw122_at_job_t job;
    for (;;) {
        if (xQueueReceive(s_ble_at_q, &job, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        if (!s_probe_ok) {
            ESP_LOGI(TAG, "re-probing UART before AT (boot probe failed)");
            s_probe_ok = ryuw122_autoprobe();
            if (!s_probe_ok) {
                static const char msg[] =
                    "+ERR: no REYAX AT reply — swap TX/RX: ESP 17→module RX, ESP 18←module TX; 3.3V+GND\n";
                ble_sen0140_uwb_line_notify((const uint8_t *)msg, sizeof(msg) - 1U);
                continue;
            }
            ESP_LOGI(TAG, "UART probe OK: TX=GPIO%d RX=GPIO%d @ %d", s_tx_gpio, s_rx_gpio, s_uart_baud);
        }
        esp_err_t err = ryuw122_uart_at_cmd(job.cmd, 5000);
        if (err == ESP_ERR_TIMEOUT) {
            static const char msg[] = "+ERR: no UART reply (check TX/RX swap, baud, 3.3V)\n";
            ble_sen0140_uwb_line_notify((const uint8_t *)msg, sizeof(msg) - 1U);
        } else if (err != ESP_OK && s_at_rsp_len == 0U) {
            static const char msg[] = "+ERR: AT failed\n";
            ble_sen0140_uwb_line_notify((const uint8_t *)msg, sizeof(msg) - 1U);
        }
    }
}

static bool ryuw122_normalize_at_cmd(const uint8_t *in, size_t in_len, char *out, size_t out_len)
{
    if (!in || !out || in_len == 0U || out_len < 2U) {
        return false;
    }
    size_t n = in_len;
    while (n > 0U && (in[n - 1U] == '\r' || in[n - 1U] == '\n' || in[n - 1U] == ' ')) {
        n--;
    }
    size_t start = 0U;
    while (start < n && (in[start] == ' ' || in[start] == '\t')) {
        start++;
    }
    n -= start;
    if (n == 0U || n >= out_len) {
        return false;
    }
    memcpy(out, in + start, n);
    out[n] = '\0';
    return true;
}

static void ryuw122_task(void *arg)
{
    (void)arg;
    uint8_t buf[64];
    char line[RYUW_BUF];
    size_t li = 0;
    unsigned idle_reads = 0;
    unsigned post_tx_idle = 0;

    for (;;) {
        const TickType_t wait = s_post_tx_drain ? pdMS_TO_TICKS(20) : pdMS_TO_TICKS(80);
        const int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), wait);
        if (n <= 0) {
            if (li > 0U) {
                idle_reads++;
                if (idle_reads >= RYUW_IDLE_FLUSH_READS) {
                    if (ryuw122_line_is_printable(line, li)) {
                        ryuw122_emit_line(line, &li);
                    } else {
                        ESP_LOGW(TAG, "discarding idle UART noise (%u bytes)", (unsigned)li);
                        ESP_LOG_BUFFER_HEXDUMP(TAG, line, li, ESP_LOG_WARN);
                        li = 0;
                    }
                    idle_reads = 0;
                }
            }
            if (s_post_tx_drain) {
                post_tx_idle++;
                if (post_tx_idle >= 40) {
                    s_post_tx_drain = false;
                    post_tx_idle = 0;
                }
            }
            continue;
        }

        idle_reads = 0;
        post_tx_idle = 0;
        for (int i = 0; i < n; i++) {
            const char c = (char)buf[i];
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
    ryuw122_apply_uart(CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_BAUD);

    s_tx_gpio = CONFIG_RYUW122_UART_TX_GPIO;
    s_rx_gpio = CONFIG_RYUW122_UART_RX_GPIO;
    s_uart_baud = CONFIG_RYUW122_UART_BAUD;
    s_post_tx_drain = false;

    s_uart_mtx = xSemaphoreCreateMutex();
    s_at_done = xSemaphoreCreateBinary();
    s_ble_at_q = xQueueCreate(2, sizeof(ryuw122_at_job_t));
    if (s_uart_mtx == NULL || s_at_done == NULL || s_ble_at_q == NULL) {
        ESP_LOGE(TAG, "mutex/semaphore/queue create failed");
        if (s_uart_mtx) {
            vSemaphoreDelete(s_uart_mtx);
            s_uart_mtx = NULL;
        }
        if (s_at_done) {
            vSemaphoreDelete(s_at_done);
            s_at_done = NULL;
        }
        if (s_ble_at_q) {
            vQueueDelete(s_ble_at_q);
            s_ble_at_q = NULL;
        }
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "UART%d: TX=GPIO%d RX=GPIO%d", CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO,
             CONFIG_RYUW122_UART_RX_GPIO);

    if (CONFIG_RYUW122_BOOT_DELAY_MS > 0) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_RYUW122_BOOT_DELAY_MS));
    }

    s_probe_ok = ryuw122_autoprobe();
    if (!s_probe_ok) {
        ESP_LOGW(TAG,
                 "No valid AT reply at boot — using menuconfig TX=GPIO%d RX=GPIO%d @ %d baud",
                 CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_BAUD);
        ESP_LOGW(TAG,
                 "REYAX wiring: ESP GPIO%d (TX) → module RX; ESP GPIO%d (RX) ← module TX; common GND; 3.3V",
                 CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO);
        ryuw122_apply_uart(CONFIG_RYUW122_UART_TX_GPIO, CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_BAUD);
        s_tx_gpio = CONFIG_RYUW122_UART_TX_GPIO;
        s_rx_gpio = CONFIG_RYUW122_UART_RX_GPIO;
        s_uart_baud = CONFIG_RYUW122_UART_BAUD;
    }

    const uint32_t stack = 4096;
    if (xTaskCreate(ryuw122_task, "ryuw122", stack, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_FAIL;
    }
    if (xTaskCreate(ryuw122_ble_at_task, "ryuw122_at", stack, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "BLE AT worker task create failed");
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
    if (s_uart_mtx == NULL || xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const int n = uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, (const char *)data, len);
    if (n < 0 || (size_t)n != len) {
        ESP_LOGW(TAG, "uart_write %u bytes → %d", (unsigned)len, n);
        xSemaphoreGive(s_uart_mtx);
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(200));
    ESP_LOGI(TAG, "TX %.*s", (int)len, (const char *)data);
    s_post_tx_drain = true;
    xSemaphoreGive(s_uart_mtx);
    return ESP_OK;
}

esp_err_t ryuw122_uart_at_cmd(const char *cmd, uint32_t timeout_ms)
{
    if (!cmd || s_uart_mtx == NULL || s_at_done == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    char line[128];
    size_t n = strlen(cmd);
    if (n >= sizeof(line) - 3U) {
        xSemaphoreGive(s_uart_mtx);
        return ESP_ERR_INVALID_ARG;
    }
    memcpy(line, cmd, n);
    if (n < 2U || line[n - 2U] != '\r' || line[n - 1U] != '\n') {
        if (n > 0U && line[n - 1U] == '\n') {
            line[n - 1U] = '\r';
            line[n++] = '\n';
        } else {
            line[n++] = '\r';
            line[n++] = '\n';
        }
    }

    s_at_rsp_len = 0;
    s_at_rsp[0] = '\0';
    s_at_ok = false;
    s_at_err = false;
    xSemaphoreTake(s_at_done, 0);

    const int w = uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, line, n);
    if (w < 0) {
        xSemaphoreGive(s_uart_mtx);
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(300));
    s_post_tx_drain = true;

    const TickType_t wait = pdMS_TO_TICKS(timeout_ms > 0U ? timeout_ms : 3000U);
    if (xSemaphoreTake(s_at_done, wait) != pdTRUE) {
        ESP_LOGW(TAG, "AT timeout: %s", cmd);
        xSemaphoreGive(s_uart_mtx);
        return ESP_ERR_TIMEOUT;
    }

    const esp_err_t res = s_at_ok && !s_at_err ? ESP_OK : ESP_FAIL;
    if (res != ESP_OK) {
        ESP_LOGW(TAG, "AT failed: %s → %s", cmd, s_at_rsp);
    }
    xSemaphoreGive(s_uart_mtx);
    return res;
}

esp_err_t ryuw122_uart_queue_ble_at(const uint8_t *data, size_t len)
{
    if (!data || len == 0U || s_ble_at_q == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (len > 256U) {
        return ESP_ERR_INVALID_ARG;
    }
    ryuw122_at_job_t job;
    if (!ryuw122_normalize_at_cmd(data, len, job.cmd, sizeof(job.cmd))) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xQueueSend(s_ble_at_q, &job, pdMS_TO_TICKS(200)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
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

esp_err_t ryuw122_uart_at_cmd(const char *cmd, uint32_t timeout_ms)
{
    (void)cmd;
    (void)timeout_ms;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t ryuw122_uart_queue_ble_at(const uint8_t *data, size_t len)
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
