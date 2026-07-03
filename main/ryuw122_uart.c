#include "ryuw122_uart.h"

#include "sdkconfig.h"

#include <stdio.h>
#include <string.h>

#if CONFIG_REGATTAONE_RYUW122_ENABLE

#include "ble_sen0140.h"
#include "device_type.h"

#include "esp_check.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
#include "meshtastic_client.h"
#endif

#if CONFIG_REGATTAONE_SC16IS752_ENABLE
#include "i2c_bus_mux.h"
#include "sc16is752.h"
#else
#include "driver/gpio.h"
#include "driver/uart.h"
#endif

static const char *TAG = "ryuw122";

#define RYUW_READ_CHUNK 64
#define RYUW_LINE_MAX 256

#define RYUW122_NETWORK_ID "REGATTA1" /* Exactly 8 ASCII bytes (REYAX AT guide) */
#define RYUW122_CPIN       CONFIG_RYUW122_CPIN
#define RYUW122_PROV_AT_MS 450

_Static_assert(sizeof(RYUW122_NETWORK_ID) - 1U == 8U, "RYUW122 NETWORKID must be 8 bytes");
_Static_assert(sizeof(RYUW122_CPIN) - 1U == 32U, "RYUW122 CPIN must be 32 hex chars");

static SemaphoreHandle_t s_uart_mtx;
static bool s_prov_anchor_done;
static bool s_prov_tag_done;
static volatile bool s_prov_worker_live;
static volatile bool s_prov_rearm;

void ryuw122_provision_try(void);

#if !CONFIG_REGATTAONE_SC16IS752_ENABLE

#define RYUW_RX_BUF 2048
#define RYUW_TX_BUF 512

static void ryuw122_apply_pins(void)
{
    (void)uart_set_pin(CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO,
                       CONFIG_RYUW122_UART_RX_GPIO, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (CONFIG_RYUW122_UART_RX_GPIO >= 0) {
        gpio_set_pull_mode((gpio_num_t)CONFIG_RYUW122_UART_RX_GPIO, GPIO_PULLUP_ONLY);
    }
}

/** Active-low NRST: high = run, brief low = hardware reset. */
static void ryuw122_nrst_pulse(void)
{
#if CONFIG_RYUW122_NRST_GPIO >= 0
    const gpio_num_t nrst = (gpio_num_t)CONFIG_RYUW122_NRST_GPIO;
    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << (unsigned)nrst,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(nrst, 1);
    vTaskDelay(pdMS_TO_TICKS(10));

    ESP_LOGI(TAG, "NRST pulse GPIO%d (%ums low)", CONFIG_RYUW122_NRST_GPIO, CONFIG_RYUW122_NRST_PULSE_MS);
    gpio_set_level(nrst, 0);
    vTaskDelay(pdMS_TO_TICKS(CONFIG_RYUW122_NRST_PULSE_MS));
    gpio_set_level(nrst, 1);
#endif
}

#endif /* !CONFIG_REGATTAONE_SC16IS752_ENABLE */

static bool ryuw122_byte_is_printable(uint8_t b)
{
    return b == '\t' || (b >= 0x20U && b <= 0x7eU);
}

static void ryuw122_log_bytes(const char *prefix, const uint8_t *data, size_t len)
{
    char formatted[RYUW_LINE_MAX * 4 + 1];
    size_t pos = 0;

    for (size_t i = 0; i < len && pos + 1U < sizeof(formatted); i++) {
        const uint8_t b = data[i];
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
    ESP_LOGI(TAG, "%s: %s", prefix, formatted);
}

static void ryuw122_emit_line(const char *prefix, char *line, size_t len)
{
    if (len == 0U) {
        return;
    }
    ryuw122_log_bytes("RX", (const uint8_t *)line, len);

#if CONFIG_REGATTAONE_SC16IS752_ENABLE
    if (prefix != NULL && prefix[0] != '\0') {
        char out[RYUW_LINE_MAX + 16U];
        const size_t plen = strlen(prefix);
        size_t out_len = 0U;
        if (plen + len + 2U <= sizeof(out)) {
            memcpy(out, prefix, plen);
            out_len = plen;
            memcpy(out + out_len, line, len);
            out_len += len;
            if (out_len == 0U || out[out_len - 1U] != '\n') {
                out[out_len++] = '\n';
            }
            ble_sen0140_uwb_line_notify((const uint8_t *)out, out_len);
            return;
        }
    }
#endif

    ble_sen0140_uwb_line_notify((const uint8_t *)line, len);
}

typedef struct {
    char line[RYUW_LINE_MAX];
    size_t len;
} ryuw122_line_buf_t;

static void ryuw122_feed_bytes(ryuw122_line_buf_t *lb, const char *prefix, const uint8_t *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        const char c = (char)data[i];
        if (c == '\r' || c == '\n') {
            if (lb->len > 0U) {
                ryuw122_emit_line(prefix, lb->line, lb->len);
                lb->len = 0;
            }
            continue;
        }
        if (lb->len < sizeof(lb->line) - 1U) {
            lb->line[lb->len++] = c;
        } else {
            ESP_LOGW(TAG, "line overflow at %u bytes, discarding", (unsigned)lb->len);
            lb->len = 0;
        }
    }
}

#if CONFIG_REGATTAONE_SC16IS752_ENABLE

static bool ryuw122_prefix_match(const uint8_t *data, size_t len, const char *prefix, size_t *skip_out)
{
    const size_t plen = strlen(prefix);
    if (len < plen || memcmp(data, prefix, plen) != 0) {
        return false;
    }
    *skip_out = plen;
    return true;
}

static bool ryuw122_resolve_write_channel(const uint8_t **data, size_t *len, sc16is752_channel_t *ch_out)
{
    const device_type_t dt = device_type_get();
    const bool use_anchor = device_type_uwb_use_anchor(dt);
    const bool use_tag = device_type_uwb_use_tag(dt);
    size_t skip = 0U;

    if (ryuw122_prefix_match(*data, *len, "@ANCHOR\n", &skip) || ryuw122_prefix_match(*data, *len, "@A\n", &skip)) {
        *data += skip;
        *len -= skip;
        *ch_out = SC16IS752_CH_A;
        if (!use_anchor) {
            ESP_LOGW(TAG, "write to ANCHOR rejected (device type has no anchor UART)");
            return false;
        }
        return true;
    }
    if (ryuw122_prefix_match(*data, *len, "@TAG\n", &skip) || ryuw122_prefix_match(*data, *len, "@B\n", &skip)) {
        *data += skip;
        *len -= skip;
        *ch_out = SC16IS752_CH_B;
        if (!use_tag) {
            ESP_LOGW(TAG, "write to TAG rejected (device type has no tag UART)");
            return false;
        }
        return true;
    }

    if (use_anchor && !use_tag) {
        *ch_out = SC16IS752_CH_A;
        return true;
    }
    if (use_tag && !use_anchor) {
        *ch_out = SC16IS752_CH_B;
        return true;
    }

    ESP_LOGW(TAG, "dual UWB: prefix write with @ANCHOR\\n or @TAG\\n (device type %s)",
             device_type_to_string(dt));
    return false;
}

static void ryuw122_drain_channel(sc16is752_channel_t ch, const char *prefix, ryuw122_line_buf_t *lb,
                                const char *label)
{
    uint8_t buf[RYUW_READ_CHUNK];
    for (;;) {
        const size_t n = sc16is752_read(ch, buf, sizeof(buf));
        if (n == 0U) {
            break;
        }
        if (label != NULL) {
            ESP_LOGI(TAG, "%s: %u bytes", label, (unsigned)n);
        }
        ryuw122_log_bytes("RX chunk", buf, n);
        ryuw122_feed_bytes(lb, prefix, buf, n);
    }
}

static void ryuw122_task(void *arg)
{
    (void)arg;
    ryuw122_line_buf_t lb_a = { 0 };
    ryuw122_line_buf_t lb_b = { 0 };

    const device_type_t dt = device_type_get();
    ESP_LOGI(TAG, "read task started (SC16IS752 type=%s anchor=%d tag=%d @ %d baud)",
             device_type_to_string(dt), (int)device_type_uwb_use_anchor(dt), (int)device_type_uwb_use_tag(dt),
             CONFIG_RYUW122_UART_BAUD);

    for (;;) {
        sc16is752_wait_rx(pdMS_TO_TICKS(50));
        const device_type_t active = device_type_get();
        i2c_bus_mux_lock();
        if (device_type_uwb_use_anchor(active)) {
            ryuw122_drain_channel(SC16IS752_CH_A, "[ANCHOR] ", &lb_a, "ANCHOR");
        }
        if (device_type_uwb_use_tag(active)) {
            ryuw122_drain_channel(SC16IS752_CH_B, "[TAG] ", &lb_b, "TAG");
        }
        i2c_bus_mux_unlock();
    }
}

esp_err_t ryuw122_uart_start(void)
{
    esp_err_t err = sc16is752_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SC16IS752 init: %s", esp_err_to_name(err));
        return err;
    }

    s_uart_mtx = xSemaphoreCreateMutex();
    if (s_uart_mtx == NULL) {
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
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "SC16IS752 listener running (type=%s, BLE 0xFEF9 lines prefixed [ANCHOR]/[TAG])",
             device_type_to_string(device_type_get()));
    ryuw122_provision_try();
    return ESP_OK;
}

esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0U) {
        ESP_LOGW(TAG, "write rejected: invalid args (data=%p len=%u)", (void *)data, (unsigned)len);
        return ESP_ERR_INVALID_ARG;
    }
    if (!sc16is752_ready()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (s_uart_mtx == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    const uint8_t *payload = data;
    size_t payload_len = len;
    sc16is752_channel_t ch;
    if (!ryuw122_resolve_write_channel(&payload, &payload_len, &ch)) {
        xSemaphoreGive(s_uart_mtx);
        return ESP_ERR_INVALID_ARG;
    }
    if (payload_len == 0U) {
        xSemaphoreGive(s_uart_mtx);
        return ESP_ERR_INVALID_ARG;
    }

    i2c_bus_mux_lock();
    const esp_err_t err = sc16is752_write(ch, payload, payload_len);
    i2c_bus_mux_unlock();

    if (err == ESP_OK) {
        ryuw122_log_bytes(ch == SC16IS752_CH_A ? "TX ANCHOR" : "TX TAG", payload, payload_len);
    }
    xSemaphoreGive(s_uart_mtx);
    return err;
}

#else /* native ESP UART */

static void ryuw122_task(void *arg)
{
    (void)arg;
    uint8_t buf[RYUW_READ_CHUNK];
    ryuw122_line_buf_t lb = { 0 };

    ESP_LOGI(TAG, "read task started (uart%d RX=GPIO%d @ %d baud)", CONFIG_RYUW122_UART_PORT_NUM,
             CONFIG_RYUW122_UART_RX_GPIO, CONFIG_RYUW122_UART_BAUD);

    for (;;) {
        const int n = uart_read_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, sizeof(buf), pdMS_TO_TICKS(50));
        if (n <= 0) {
            continue;
        }

        ESP_LOGI(TAG, "read %d bytes from uart%d", n, CONFIG_RYUW122_UART_PORT_NUM);
        ryuw122_log_bytes("RX chunk", buf, (size_t)n);
        ryuw122_feed_bytes(&lb, NULL, buf, (size_t)n);
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
    uart_flush(CONFIG_RYUW122_UART_PORT_NUM);
    uart_flush_input(CONFIG_RYUW122_UART_PORT_NUM);

    ryuw122_nrst_pulse();

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
    ryuw122_provision_try();
    return ESP_OK;
}

esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0U) {
        ESP_LOGW(TAG, "write rejected: invalid args (data=%p len=%u)", (void *)data, (unsigned)len);
        return ESP_ERR_INVALID_ARG;
    }

    const char *task = pcTaskGetName(NULL);
    ESP_LOGI(TAG, "write %u bytes from task '%s' (uart%d TX=GPIO%d)", (unsigned)len, task ? task : "?",
             CONFIG_RYUW122_UART_PORT_NUM, CONFIG_RYUW122_UART_TX_GPIO);

    if (s_uart_mtx == NULL) {
        ESP_LOGE(TAG, "write failed: UART not started (mutex NULL)");
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        ESP_LOGE(TAG, "write mutex timeout after 5s (task '%s')", task ? task : "?");
        return ESP_ERR_TIMEOUT;
    }

    const int n = uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, (const char *)data, len);
    if (n < 0 || (size_t)n != len) {
        ESP_LOGW(TAG, "uart_write_bytes returned %d (expected %u)", n, (unsigned)len);
        xSemaphoreGive(s_uart_mtx);
        return ESP_FAIL;
    }

    const esp_err_t tx_done = uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(500));
    if (tx_done != ESP_OK) {
        ESP_LOGW(TAG, "uart_wait_tx_done: %s", esp_err_to_name(tx_done));
    }

    ryuw122_log_bytes("TX", data, len);
    ESP_LOGI(TAG, "write done (%u bytes, tx_done=%s)", (unsigned)len, esp_err_to_name(tx_done));
    xSemaphoreGive(s_uart_mtx);
    return ESP_OK;
}

#endif /* CONFIG_REGATTAONE_SC16IS752_ENABLE */

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE

/** RYUW122 ADDRESS is exactly 8 ASCII bytes; prefix role + 7 hex digits of node num. */
static void ryuw122_format_address(char *out, size_t out_len, bool anchor, uint32_t node_num)
{
    (void)snprintf(out, out_len, "%c%07lX", anchor ? 'A' : 'T', (unsigned long)(node_num & 0x0FFFFFFFU));
}

#if CONFIG_REGATTAONE_SC16IS752_ENABLE
static esp_err_t ryuw122_send_at_line_ch(sc16is752_channel_t ch, const char *at_line)
{
    if (!sc16is752_ready() || s_uart_mtx == NULL || at_line == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    char buf[128];
    const int n = snprintf(buf, sizeof(buf), "%s\r\n", at_line);
    if (n <= 0 || (size_t)n >= sizeof(buf)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    i2c_bus_mux_lock();
    const esp_err_t err = sc16is752_write(ch, (const uint8_t *)buf, (size_t)n);
    i2c_bus_mux_unlock();
    xSemaphoreGive(s_uart_mtx);
    if (err == ESP_OK) {
        ryuw122_log_bytes(ch == SC16IS752_CH_A ? "TX ANCHOR" : "TX TAG", (const uint8_t *)buf, (size_t)n);
    }
    return err;
}

static esp_err_t ryuw122_provision_role_sc16(sc16is752_channel_t ch, bool anchor, uint32_t node_num)
{
    char address[24];
    char line[96];
    const char *role = anchor ? "ANCHOR" : "TAG";

    ryuw122_format_address(address, sizeof(address), anchor, node_num);

    (void)snprintf(line, sizeof(line), "AT+MODE=%s", anchor ? "1" : "0");
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_ch(ch, line), TAG, "MODE");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    (void)snprintf(line, sizeof(line), "AT+NETWORKID=%s", RYUW122_NETWORK_ID);
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_ch(ch, line), TAG, "NETWORKID");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    (void)snprintf(line, sizeof(line), "AT+ADDRESS=%s", address);
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_ch(ch, line), TAG, "ADDRESS");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    (void)snprintf(line, sizeof(line), "AT+CPIN=%s", RYUW122_CPIN);
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_ch(ch, line), TAG, "CPIN");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    ESP_LOGI(TAG, "%s provision: MODE=%s NETWORKID=%s ADDRESS=%s CPIN sent", role, anchor ? "1" : "0",
             RYUW122_NETWORK_ID, address);
    return ESP_OK;
}
#else
static esp_err_t ryuw122_send_at_line_native(const char *at_line)
{
    if (s_uart_mtx == NULL || at_line == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    char buf[128];
    const int n = snprintf(buf, sizeof(buf), "%s\r\n", at_line);
    if (n <= 0 || (size_t)n >= sizeof(buf)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_uart_mtx, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const int w = uart_write_bytes(CONFIG_RYUW122_UART_PORT_NUM, buf, (size_t)n);
    if (w < 0 || (size_t)w != (size_t)n) {
        xSemaphoreGive(s_uart_mtx);
        return ESP_FAIL;
    }
    (void)uart_wait_tx_done(CONFIG_RYUW122_UART_PORT_NUM, pdMS_TO_TICKS(500));
    ryuw122_log_bytes("TX", (const uint8_t *)buf, (size_t)n);
    xSemaphoreGive(s_uart_mtx);
    return ESP_OK;
}

static esp_err_t ryuw122_provision_role_native(bool anchor, uint32_t node_num)
{
    char address[24];
    char line[96];

    ryuw122_format_address(address, sizeof(address), anchor, node_num);

    (void)snprintf(line, sizeof(line), "AT+MODE=%s", anchor ? "1" : "0");
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_native(line), TAG, "MODE");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    (void)snprintf(line, sizeof(line), "AT+NETWORKID=%s", RYUW122_NETWORK_ID);
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_native(line), TAG, "NETWORKID");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    (void)snprintf(line, sizeof(line), "AT+ADDRESS=%s", address);
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_native(line), TAG, "ADDRESS");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    (void)snprintf(line, sizeof(line), "AT+CPIN=%s", RYUW122_CPIN);
    ESP_RETURN_ON_ERROR(ryuw122_send_at_line_native(line), TAG, "CPIN");
    vTaskDelay(pdMS_TO_TICKS(RYUW122_PROV_AT_MS));

    ESP_LOGI(TAG, "RYUW122 provision: MODE=%s ADDRESS=%s", anchor ? "1" : "0", address);
    return ESP_OK;
}
#endif

static void ryuw122_provision_worker(void *arg)
{
    (void)arg;
    uint32_t node_num = 0U;
    if (!meshtastic_client_get_my_num(&node_num)) {
        s_prov_worker_live = false;
        vTaskDelete(NULL);
        return;
    }

    const device_type_t dt = device_type_get();

#if CONFIG_REGATTAONE_SC16IS752_ENABLE
    if (device_type_uwb_use_anchor(dt) && !s_prov_anchor_done) {
        if (ryuw122_provision_role_sc16(SC16IS752_CH_A, true, node_num) == ESP_OK) {
            s_prov_anchor_done = true;
        }
    }
    if (device_type_uwb_use_tag(dt) && !s_prov_tag_done) {
        if (ryuw122_provision_role_sc16(SC16IS752_CH_B, false, node_num) == ESP_OK) {
            s_prov_tag_done = true;
        }
    }
#else
    if (device_type_uwb_use_anchor(dt) && !device_type_uwb_use_tag(dt) && !s_prov_anchor_done) {
        if (ryuw122_provision_role_native(true, node_num) == ESP_OK) {
            s_prov_anchor_done = true;
        }
    } else if (device_type_uwb_use_tag(dt) && !s_prov_tag_done) {
        if (ryuw122_provision_role_native(false, node_num) == ESP_OK) {
            s_prov_tag_done = true;
        }
    }
#endif

    s_prov_worker_live = false;
    if (s_prov_rearm) {
        s_prov_rearm = false;
        ryuw122_provision_try();
    }
    vTaskDelete(NULL);
}

void ryuw122_provision_on_device_type_changed(void)
{
    s_prov_anchor_done = false;
    s_prov_tag_done = false;
    if (s_prov_worker_live) {
        s_prov_rearm = true;
        return;
    }
    ryuw122_provision_try();
}

void ryuw122_provision_try(void)
{
    uint32_t node_num = 0U;
    if (!meshtastic_client_get_my_num(&node_num)) {
        return;
    }

    const device_type_t dt = device_type_get();
    const bool need_anchor = device_type_uwb_use_anchor(dt) && !s_prov_anchor_done;
    const bool need_tag = device_type_uwb_use_tag(dt) && !s_prov_tag_done;
    if (!need_anchor && !need_tag) {
        return;
    }

#if CONFIG_REGATTAONE_SC16IS752_ENABLE
    if (!sc16is752_ready() || s_uart_mtx == NULL) {
        return;
    }
#else
    if (s_uart_mtx == NULL) {
        return;
    }
#endif

    if (s_prov_worker_live) {
        return;
    }
    s_prov_worker_live = true;
    if (xTaskCreate(ryuw122_provision_worker, "ryuw122_prov", 4096, NULL, 4, NULL) != pdPASS) {
        s_prov_worker_live = false;
        ESP_LOGW(TAG, "provision task create failed");
    }
}

#else /* !CONFIG_REGATTAONE_MESHTASTIC_ENABLE */

void ryuw122_provision_on_device_type_changed(void)
{
}

void ryuw122_provision_try(void)
{
}

#endif /* CONFIG_REGATTAONE_MESHTASTIC_ENABLE */

bool ryuw122_tdma_can_use_now(void)
{
    return true;
}

int64_t ryuw122_tdma_us_until_window(void)
{
    return 0;
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

void ryuw122_provision_on_device_type_changed(void)
{
}

void ryuw122_provision_try(void)
{
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
