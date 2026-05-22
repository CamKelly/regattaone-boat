#include "ryuw122_uart.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_RYUW122_ENABLE
#include "driver/uart.h"

#include "ble_sen0140.h"

static const char *TAG = "ryuw122";

#define RYUW_BUF 256
#define RYUW_IDLE_FLUSH_READS 25
#define RYUW_AT_RSP_MAX 384

static int s_uart_baud;
static int s_tx_gpio;
static int s_rx_gpio;

static volatile bool s_post_tx_drain;
static SemaphoreHandle_t s_uart_mtx;
static SemaphoreHandle_t s_at_done;
static char s_at_rsp[RYUW_AT_RSP_MAX];
static size_t s_at_rsp_len;
static bool s_at_ok;
static bool s_at_err;

static ryuw122_config_t s_cfg;
static bool s_cfg_valid;
static TaskHandle_t s_range_task;
static volatile bool s_range_run;

static void ryuw122_emit_line(char *line, size_t *li);
static bool ryuw122_parse_anchor_rcv(const char *line, float *dist_cm, char *peer, size_t peer_sz);

static void ryuw122_at_append_line(const char *line)
{
    if (!line) {
        return;
    }
    if (strstr(line, "+OK") != NULL) {
        s_at_ok = true;
    }
    if (strstr(line, "+ERR") != NULL) {
        s_at_err = true;
    }
    size_t n = strlen(line);
    if (s_at_rsp_len + n + 2U < sizeof(s_at_rsp)) {
        memcpy(s_at_rsp + s_at_rsp_len, line, n);
        s_at_rsp_len += n;
        s_at_rsp[s_at_rsp_len++] = '\n';
        s_at_rsp[s_at_rsp_len] = '\0';
    }
    if (s_at_done && (s_at_ok || s_at_err)) {
        xSemaphoreGive(s_at_done);
    }
}

static void ryuw122_emit_line(char *line, size_t *li)
{
    if (*li == 0U) {
        return;
    }
    line[*li] = '\0';
    ESP_LOGI(TAG, "RX: %s", line);

    float dist_cm = 0.f;
    char peer[RYUW122_ADDRESS_LEN + 1];
    if (ryuw122_parse_anchor_rcv(line, &dist_cm, peer, sizeof(peer))) {
        ble_sen0140_uwb_distance_notify(dist_cm, peer);
    }

    if (s_at_done != NULL) {
        ryuw122_at_append_line(line);
    }

    ble_sen0140_uwb_line_notify((const uint8_t *)line, *li);
    *li = 0;
}

static bool ryuw122_parse_anchor_rcv(const char *line, float *dist_cm, char *peer, size_t peer_sz)
{
    static const char prefix[] = "+ANCHOR_RCV=";
    if (!line || !dist_cm || !peer || peer_sz < 2U) {
        return false;
    }
    if (strncmp(line, prefix, sizeof(prefix) - 1U) != 0) {
        return false;
    }
    const char *p = line + sizeof(prefix) - 1U;
    const char *comma1 = strchr(p, ',');
    if (!comma1) {
        return false;
    }
    size_t addr_len = (size_t)(comma1 - p);
    if (addr_len == 0U || addr_len >= peer_sz) {
        return false;
    }
    memcpy(peer, p, addr_len);
    peer[addr_len] = '\0';

    const char *cm = strstr(line, " cm");
    if (!cm) {
        return false;
    }
    const char *scan = cm;
    while (scan > comma1 && (*scan < '0' || *scan > '9') && *scan != '.' && *scan != '-') {
        scan--;
    }
    const char *dstart = scan;
    while (dstart > comma1 && (isdigit((unsigned char)dstart[-1]) || dstart[-1] == '.')) {
        dstart--;
    }
    if (dstart >= cm) {
        return false;
    }
    *dist_cm = strtof(dstart, NULL);
    return true;
}

static bool ryuw122_send_at_probe(int tx_gpio, int rx_gpio, int baud)
{
    if (uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, tx_gpio, rx_gpio, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) !=
        ESP_OK) {
        return false;
    }
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
    vTaskDelay(pdMS_TO_TICKS(50));

    uint8_t buf[128];
    const int len = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(600));
    if (len <= 0) {
        return false;
    }
    ESP_LOGI(TAG, "AT OK: TX=GPIO%d RX=GPIO%d @ %d — %d byte(s)", tx_gpio, rx_gpio, baud, len);
    ESP_LOG_BUFFER_HEXDUMP(TAG, buf, (size_t)len, ESP_LOG_INFO);
    return true;
}

static bool ryuw122_autoprobe(void)
{
    static const int bauds[] = {115200, 9600};
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
                if (li > 0U) {
                    ESP_LOGW(TAG, "TX/RX were swapped — use ESP TX=GPIO%d, RX=GPIO%d", s_tx_gpio, s_rx_gpio);
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
                    ryuw122_emit_line(line, &li);
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

static void ryuw122_range_task(void *arg)
{
    (void)arg;
    char cmd[96];
    for (;;) {
        if (!s_range_run || !s_cfg_valid) {
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        const uint32_t interval = s_cfg.range_interval_ms > 0U ? s_cfg.range_interval_ms : 500U;

        if (s_cfg.role == RYUW122_ROLE_ANCHOR) {
            const char *payload = s_cfg.anchor_payload[0] ? s_cfg.anchor_payload : "TST";
            const size_t plen = strlen(payload);
            snprintf(cmd, sizeof(cmd), "AT+ANCHOR_SEND=%s,%u,%s", s_cfg.peer_address, (unsigned)plen, payload);
            (void)ryuw122_uart_at_cmd(cmd, interval);
        } else {
            const char *payload = s_cfg.tag_payload[0] ? s_cfg.tag_payload : "HELLO";
            const size_t plen = strlen(payload);
            snprintf(cmd, sizeof(cmd), "AT+TAG_SEND=%u,%s", (unsigned)plen, payload);
            (void)ryuw122_uart_at_cmd(cmd, interval);
        }
        vTaskDelay(pdMS_TO_TICKS(interval));
    }
}

esp_err_t ryuw122_uart_start(void)
{
    s_uart_mtx = xSemaphoreCreateMutex();
    s_at_done = xSemaphoreCreateBinary();
    if (!s_uart_mtx || !s_at_done) {
        return ESP_ERR_NO_MEM;
    }

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
    s_post_tx_drain = false;
    s_cfg_valid = false;
    s_range_run = false;

    ESP_LOGI(TAG, "UART%d: TX=GPIO%d RX=GPIO%d", CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO,
             CONFIG_RYUW122_UART_RX_GPIO);

    if (CONFIG_RYUW122_BOOT_DELAY_MS > 0) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_RYUW122_BOOT_DELAY_MS));
    }

    if (!ryuw122_autoprobe()) {
        ESP_LOGW(TAG, "No AT reply at boot");
        (void)uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO,
                           CONFIG_RYUW122_UART_RX_GPIO, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
        (void)uart_set_baudrate(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_BAUD);
    }

    const uint32_t stack = 4096;
    if (xTaskCreate(ryuw122_task, "ryuw122", stack, NULL, 5, NULL) != pdPASS) {
        uart_driver_delete(CONFIG_RYUW122_UART_PORT_NUM);
        return ESP_FAIL;
    }
    if (xTaskCreate(ryuw122_range_task, "ryuw_rng", 3072, NULL, 4, &s_range_task) != pdPASS) {
        ESP_LOGW(TAG, "range task create failed");
    }

    ESP_LOGI(TAG, "UART%d active: TX=GPIO%d RX=GPIO%d @ %d baud", CONFIG_RYUW122_UART_PORT_NUM, s_tx_gpio,
             s_rx_gpio, s_uart_baud);

    ryuw122_config_t boot_cfg;
    if (ryuw122_config_load(&boot_cfg) == ESP_OK) {
        (void)ryuw122_config_apply(&boot_cfg);
    }
    return ESP_OK;
}

esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
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
    if (!cmd) {
        return ESP_ERR_INVALID_ARG;
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

    esp_err_t res = s_at_ok && !s_at_err ? ESP_OK : ESP_FAIL;
    if (res != ESP_OK) {
        ESP_LOGW(TAG, "AT failed: %s → %s", cmd, s_at_rsp);
    }
    xSemaphoreGive(s_uart_mtx);
    return res;
}

esp_err_t ryuw122_uart_apply_role(const ryuw122_config_t *cfg)
{
    if (!cfg) {
        return ESP_ERR_INVALID_ARG;
    }
    memcpy(&s_cfg, cfg, sizeof(s_cfg));
    s_cfg_valid = true;
    return ESP_OK;
}

void ryuw122_uart_set_ranging(const ryuw122_config_t *cfg)
{
    if (!cfg) {
        s_range_run = false;
        return;
    }
    memcpy(&s_cfg, cfg, sizeof(s_cfg));
    s_cfg_valid = true;
    s_range_run = cfg->auto_range;
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

esp_err_t ryuw122_uart_apply_role(const ryuw122_config_t *cfg)
{
    (void)cfg;
    return ESP_ERR_NOT_SUPPORTED;
}

void ryuw122_uart_set_ranging(const ryuw122_config_t *cfg)
{
    (void)cfg;
}

#endif
