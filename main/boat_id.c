#include "boat_id.h"

#include <ctype.h>
#include <string.h>

#include "boat_note.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "boat_id";
static const char *NVS_NS = "boat";
static const char *NVS_KEY = "id";

static char s_boat_id[BOAT_ID_MAX_LEN + 1U];
static char s_ble_name[BOAT_ID_BLE_NAME_MAX_LEN + 1U];

static void refresh_ble_name(void)
{
    const char *id = s_boat_id;
    if (id[0] == '\0') {
        strncpy(s_ble_name, BOAT_ID_DEFAULT_BLE_NAME, sizeof(s_ble_name) - 1U);
    } else {
        strncpy(s_ble_name, id, BOAT_ID_BLE_NAME_MAX_LEN);
    }
    s_ble_name[sizeof(s_ble_name) - 1U] = '\0';
}

static bool is_valid_boat_id(const char *id, size_t len)
{
    if (len == 0U || len > BOAT_ID_MAX_LEN) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)id[i];
        if (c < 0x20 || c > 0x7e) {
            return false;
        }
    }
    return true;
}

esp_err_t boat_id_init(void)
{
    s_boat_id[0] = '\0';

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return ESP_OK;
    }

    size_t len = sizeof(s_boat_id);
    err = nvs_get_str(h, NVS_KEY, s_boat_id, &len);
    nvs_close(h);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "loaded id \"%s\"", s_boat_id);
    }
    refresh_ble_name();
    return ESP_OK;
}

const char *boat_id_get(void)
{
    return s_boat_id;
}

const char *boat_id_ble_name(void)
{
    return s_ble_name;
}

esp_err_t boat_id_set(const char *id, size_t len)
{
    if (!id) {
        return ESP_ERR_INVALID_ARG;
    }
    while (len > 0U && (id[len - 1U] == ' ' || id[len - 1U] == '\t')) {
        len--;
    }
    size_t start = 0U;
    while (start < len && (id[start] == ' ' || id[start] == '\t')) {
        start++;
    }
    id += start;
    len -= start;

    if (!is_valid_boat_id(id, len)) {
        ESP_LOGW(TAG, "reject id len=%u", (unsigned)len);
        return ESP_ERR_INVALID_ARG;
    }

    char tmp[BOAT_ID_MAX_LEN + 1U];
    memcpy(tmp, id, len);
    tmp[len] = '\0';

    const bool had_id = s_boat_id[0] != '\0';
    const bool id_changed = !had_id || strcmp(s_boat_id, tmp) != 0;

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, NVS_KEY, tmp);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        return err;
    }

    strncpy(s_boat_id, tmp, sizeof(s_boat_id) - 1U);
    s_boat_id[sizeof(s_boat_id) - 1U] = '\0';
    refresh_ble_name();
    ESP_LOGI(TAG, "saved id \"%s\" ble_name \"%s\"", s_boat_id, s_ble_name);
    if (id_changed) {
        boat_notehub_report_async(had_id ? BOAT_NOTE_CHANGED : BOAT_NOTE_SET);
    }
    return ESP_OK;
}
