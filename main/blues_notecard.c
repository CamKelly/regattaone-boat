/*
 * Blues Notecard (LoRa) over I2C using the same serial-over-I2C framing as
 * blues/note-arduino NoteI2c_Arduino (MIT). See Notecard for LoRa + Notecarrier.
 */
#include "blues_notecard.h"

#include <stdlib.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "i2c_bus_mux.h"
#include "sdkconfig.h"

static const char *TAG = "blues_nc";

#define NC_I2C_TIMEOUT_MS       500
#define NC_CHUNK_DELAY_MS       20
#define NC_SEGMENT_DELAY_MS     250
#define NC_SEGMENT_MAX_PAYLOAD  250
#define NC_MAX_I2C_PAYLOAD      253
#define NC_REQUEST_HEADER_SIZE  2
#define NC_REQUEST_MAX_SIZE     255
#define NC_RX_TMP               260
#define NC_READ_CHUNK           128

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;

#if CONFIG_REGATTAONE_NOTECARD_ENABLE

static esp_err_t nc_bus_create_standalone(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = CONFIG_NOTECARD_I2C_PORT_NUM,
        .scl_io_num = CONFIG_NOTECARD_I2C_SCL_GPIO,
        .sda_io_num = CONFIG_NOTECARD_I2C_SDA_GPIO,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s_bus), TAG, "new bus");
    vTaskDelay(pdMS_TO_TICKS(50));
    return ESP_OK;
}

static esp_err_t nc_add_device(void)
{
    i2c_device_config_t cfg = {
        .device_address = CONFIG_NOTECARD_I2C_ADDR_7BIT,
        .scl_speed_hz = CONFIG_NOTECARD_I2C_FREQ_HZ,
    };
    return i2c_master_bus_add_device(s_bus, &cfg, &s_dev);
}

static esp_err_t nc_tx_segment(const uint8_t *payload, size_t payload_len)
{
    if (payload_len == 0U || payload_len > NC_MAX_I2C_PAYLOAD) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t buf[1 + NC_MAX_I2C_PAYLOAD];
    buf[0] = (uint8_t)payload_len;
    memcpy(buf + 1, payload, payload_len);
    return i2c_master_transmit(s_dev, buf, 1U + payload_len, NC_I2C_TIMEOUT_MS);
}

static esp_err_t nc_chunked_transmit(const uint8_t *data, size_t size)
{
    const uint8_t *chunk = data;
    uint16_t sent_in_segment = 0;
    while (size > 0U) {
        vTaskDelay(pdMS_TO_TICKS(6));
        uint16_t chunk_len = (size > NC_MAX_I2C_PAYLOAD) ? NC_MAX_I2C_PAYLOAD : (uint16_t)size;
        ESP_RETURN_ON_ERROR(nc_tx_segment(chunk, chunk_len), TAG, "tx seg");
        chunk += chunk_len;
        size -= chunk_len;
        sent_in_segment = (uint16_t)(sent_in_segment + chunk_len);
        if (sent_in_segment > NC_SEGMENT_MAX_PAYLOAD) {
            sent_in_segment = 0;
            vTaskDelay(pdMS_TO_TICKS(NC_SEGMENT_DELAY_MS));
        }
        vTaskDelay(pdMS_TO_TICKS(NC_CHUNK_DELAY_MS));
    }
    return ESP_OK;
}

static esp_err_t nc_i2c_receive(uint8_t request_data_len, uint8_t *data_out, uint32_t *available_out)
{
    uint8_t wr[2] = {0, request_data_len};
    ESP_RETURN_ON_ERROR(i2c_master_transmit(s_dev, wr, sizeof(wr), NC_I2C_TIMEOUT_MS), TAG, "rx wr");
    vTaskDelay(pdMS_TO_TICKS(2));
    const size_t rd_len = (size_t)NC_REQUEST_HEADER_SIZE + (size_t)request_data_len;
    if (rd_len > NC_RX_TMP) {
        return ESP_ERR_INVALID_SIZE;
    }
    uint8_t tmp[NC_RX_TMP];
    ESP_RETURN_ON_ERROR(i2c_master_receive(s_dev, tmp, rd_len, NC_I2C_TIMEOUT_MS), TAG, "rx rd");
    const uint32_t avail = tmp[0];
    if (avail > (uint32_t)(NC_REQUEST_MAX_SIZE - NC_REQUEST_HEADER_SIZE)) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    if (tmp[1] != request_data_len) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    if (request_data_len > 0U && data_out != NULL) {
        memcpy(data_out, tmp + NC_REQUEST_HEADER_SIZE, request_data_len);
    }
    *available_out = avail;
    return ESP_OK;
}

static esp_err_t nc_query_length(uint32_t *available, uint32_t timeout_ms)
{
    const TickType_t t0 = xTaskGetTickCount();
    for (;;) {
        uint8_t dummy = 0;
        uint32_t av = 0;
        esp_err_t e = nc_i2c_receive(0, &dummy, &av);
        if (e != ESP_OK) {
            return e;
        }
        *available = av;
        if (av > 0U) {
            return ESP_OK;
        }
        if (timeout_ms > 0U && (xTaskGetTickCount() - t0) >= pdMS_TO_TICKS(timeout_ms)) {
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

static bool response_has_complete_line(const uint8_t *buf, size_t len)
{
    return len > 0U && memchr(buf, '\n', len) != NULL;
}

esp_err_t blues_notecard_init(i2c_master_bus_handle_t shared_bus_or_null)
{
    s_dev = NULL;
    s_bus = NULL;

    if (shared_bus_or_null != NULL) {
        s_bus = shared_bus_or_null;
    } else {
        ESP_RETURN_ON_ERROR(nc_bus_create_standalone(), TAG, "standalone bus");
    }
    return nc_add_device();
}

esp_err_t blues_notecard_transaction(const char *json_line, size_t json_len, char **response_out)
{
    if (response_out == NULL || json_line == NULL || json_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    *response_out = NULL;
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (json_line[json_len - 1] != '\n') {
        ESP_LOGW(TAG, "request must end with newline");
        return ESP_ERR_INVALID_ARG;
    }

    i2c_bus_mux_lock();
    esp_err_t err = nc_chunked_transmit((const uint8_t *)json_line, json_len);
    if (err != ESP_OK) {
        i2c_bus_mux_unlock();
        return err;
    }

    vTaskDelay(pdMS_TO_TICKS(6));

    size_t cap = 512U;
    uint8_t *buf = (uint8_t *)malloc(cap);
    if (buf == NULL) {
        i2c_bus_mux_unlock();
        return ESP_ERR_NO_MEM;
    }
    size_t total = 0;

    uint32_t available = 0;
    err = nc_query_length(&available, 30000U);
    if (err != ESP_OK) {
        free(buf);
        i2c_bus_mux_unlock();
        return err;
    }

    const TickType_t t_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(30000U);
    for (;;) {
        while (available == 0U) {
            if (xTaskGetTickCount() >= t_deadline) {
                free(buf);
                i2c_bus_mux_unlock();
                return ESP_ERR_TIMEOUT;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
            err = nc_query_length(&available, 0U);
            if (err != ESP_OK) {
                free(buf);
                i2c_bus_mux_unlock();
                return err;
            }
        }

        const uint32_t chunk = (available > NC_READ_CHUNK) ? NC_READ_CHUNK : available;
        if (total + chunk + 1U > cap) {
            size_t new_cap = cap * 2U;
            while (total + chunk + 1U > new_cap) {
                new_cap *= 2U;
            }
            uint8_t *nb = (uint8_t *)realloc(buf, new_cap);
            if (nb == NULL) {
                free(buf);
                i2c_bus_mux_unlock();
                return ESP_ERR_NO_MEM;
            }
            buf = nb;
            cap = new_cap;
        }

        err = nc_i2c_receive((uint8_t)chunk, buf + total, &available);
        if (err != ESP_OK) {
            free(buf);
            i2c_bus_mux_unlock();
            return err;
        }
        total += chunk;
        buf[total] = '\0';

        if (response_has_complete_line(buf, total) && available == 0U) {
            break;
        }
        if (xTaskGetTickCount() >= t_deadline && !response_has_complete_line(buf, total)) {
            free(buf);
            i2c_bus_mux_unlock();
            return ESP_ERR_TIMEOUT;
        }
    }

    i2c_bus_mux_unlock();
    *response_out = (char *)buf;
    return ESP_OK;
}

#else /* !CONFIG_REGATTAONE_NOTECARD_ENABLE */

esp_err_t blues_notecard_init(i2c_master_bus_handle_t shared_bus_or_null)
{
    (void)shared_bus_or_null;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t blues_notecard_transaction(const char *json_line, size_t json_len, char **response_out)
{
    (void)json_line;
    (void)json_len;
    if (response_out) {
        *response_out = NULL;
    }
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
