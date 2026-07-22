#include "device_type.h"

#include <ctype.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "device_type";
static const char *NVS_NS = "boat";
static const char *NVS_KEY = "type";

static device_type_t s_type = DEVICE_TYPE_BOAT;
static bool s_type_in_nvs;

static device_type_t default_type(void)
{
#if CONFIG_DEVICE_DEFAULT_TYPE_PORT
    return DEVICE_TYPE_PORT;
#elif CONFIG_DEVICE_DEFAULT_TYPE_STARBOARD
    return DEVICE_TYPE_STARBOARD;
#else
    return DEVICE_TYPE_BOAT;
#endif
}

const char *device_type_to_string(device_type_t type)
{
    switch (type) {
    case DEVICE_TYPE_PORT:
        return "port";
    case DEVICE_TYPE_STARBOARD:
        return "starboard";
    case DEVICE_TYPE_BOAT:
    default:
        return "boat";
    }
}

bool device_type_has_anchor_role(device_type_t type)
{
    return type == DEVICE_TYPE_BOAT;
}

bool device_type_has_tag_role(device_type_t type)
{
    return type == DEVICE_TYPE_PORT || type == DEVICE_TYPE_STARBOARD;
}

static bool parse_normalized(const char *tmp, device_type_t *out)
{
    if (strcmp(tmp, "port") == 0 || strcmp(tmp, "port_anchor") == 0) {
        *out = DEVICE_TYPE_PORT;
        return true;
    }
    if (strcmp(tmp, "starboard") == 0 || strcmp(tmp, "starboard_anchor") == 0) {
        *out = DEVICE_TYPE_STARBOARD;
        return true;
    }
    if (strcmp(tmp, "boat") == 0) {
        *out = DEVICE_TYPE_BOAT;
        return true;
    }
    /* Legacy types removed from the product — map to boat until reconfigured. */
    if (strcmp(tmp, "waypoint") == 0 || strcmp(tmp, "waypoint_anchor") == 0 ||
        strcmp(tmp, "fixed_dgps_mark") == 0) {
        *out = DEVICE_TYPE_BOAT;
        ESP_LOGW(TAG, "legacy type \"%s\" → boat", tmp);
        return true;
    }
    return false;
}

bool device_type_from_string(const char *s, size_t len, device_type_t *out)
{
    if (!s || !out) {
        return false;
    }
    while (len > 0U && (s[len - 1U] == ' ' || s[len - 1U] == '\t' || s[len - 1U] == '\r' || s[len - 1U] == '\n')) {
        len--;
    }
    size_t start = 0U;
    while (start < len && (s[start] == ' ' || s[start] == '\t')) {
        start++;
    }
    s += start;
    len -= start;

    char tmp[DEVICE_TYPE_STR_MAX + 1U];
    if (len == 0U || len > DEVICE_TYPE_STR_MAX) {
        return false;
    }
    memcpy(tmp, s, len);
    tmp[len] = '\0';
    for (size_t i = 0; i < len; i++) {
        tmp[i] = (char)tolower((unsigned char)tmp[i]);
    }
    for (char *p = tmp; *p != '\0'; p++) {
        if (*p == '-') {
            *p = '_';
        }
    }
    return parse_normalized(tmp, out);
}

esp_err_t device_type_init(void)
{
    s_type = default_type();
    s_type_in_nvs = false;

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return ESP_OK;
    }

    char buf[DEVICE_TYPE_STR_MAX + 1U];
    size_t len = sizeof(buf);
    err = nvs_get_str(h, NVS_KEY, buf, &len);
    nvs_close(h);
    if (err == ESP_OK) {
        device_type_t parsed;
        if (device_type_from_string(buf, strlen(buf), &parsed)) {
            s_type = parsed;
            s_type_in_nvs = true;
            ESP_LOGI(TAG, "loaded type \"%s\" (anchor_role=%d tag_role=%d)", device_type_to_string(s_type),
                     (int)device_type_has_anchor_role(s_type), (int)device_type_has_tag_role(s_type));
        }
    }
    return ESP_OK;
}

device_type_t device_type_get(void)
{
    return s_type;
}

esp_err_t device_type_set(device_type_t type)
{
    if (type > DEVICE_TYPE_BOAT) {
        return ESP_ERR_INVALID_ARG;
    }

    const char *str = device_type_to_string(type);
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, NVS_KEY, str);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        return err;
    }

    s_type = type;
    s_type_in_nvs = true;
    ESP_LOGI(TAG, "saved type \"%s\" (anchor_role=%d tag_role=%d)", str, (int)device_type_has_anchor_role(type),
             (int)device_type_has_tag_role(type));
    return ESP_OK;
}
