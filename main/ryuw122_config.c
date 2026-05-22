#include "ryuw122_config.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_RYUW122_ENABLE
#include "ble_sen0140.h"
#include "ryuw122_uart.h"
#endif

static const char *TAG = "ryuw122_cfg";
static const char *NVS_NS = "uwb";
static const char *NVS_KEY = "cfg";

static ryuw122_config_t s_active;

static void ryuw122_config_defaults(ryuw122_config_t *cfg)
{
    memset(cfg, 0, sizeof(*cfg));
#if CONFIG_RYUW122_DEFAULT_ROLE_ANCHOR
    cfg->role = RYUW122_ROLE_ANCHOR;
#else
    cfg->role = RYUW122_ROLE_TAG;
#endif
    strncpy(cfg->network_id, CONFIG_RYUW122_DEFAULT_NETWORKID, sizeof(cfg->network_id) - 1U);
    strncpy(cfg->address, CONFIG_RYUW122_DEFAULT_ADDRESS, sizeof(cfg->address) - 1U);
    strncpy(cfg->password, CONFIG_RYUW122_DEFAULT_PASSWORD, sizeof(cfg->password) - 1U);
    strncpy(cfg->peer_address, CONFIG_RYUW122_DEFAULT_PEER_ADDRESS, sizeof(cfg->peer_address) - 1U);
    strncpy(cfg->anchor_payload, CONFIG_RYUW122_DEFAULT_ANCHOR_PAYLOAD, sizeof(cfg->anchor_payload) - 1U);
    strncpy(cfg->tag_payload, CONFIG_RYUW122_DEFAULT_TAG_PAYLOAD, sizeof(cfg->tag_payload) - 1U);
    cfg->range_interval_ms = (uint16_t)CONFIG_RYUW122_DEFAULT_RANGE_MS;
    cfg->auto_range = CONFIG_RYUW122_DEFAULT_AUTO_RANGE;
}

static bool is_8byte_ascii(const char *s)
{
    if (!s) {
        return false;
    }
    size_t n = strlen(s);
    if (n != RYUW122_NETWORK_ID_LEN && n != RYUW122_ADDRESS_LEN) {
        return false;
    }
    for (size_t i = 0; i < n; i++) {
        if (!isprint((unsigned char)s[i])) {
            return false;
        }
    }
    return true;
}

static bool is_hex32(const char *s)
{
    if (!s || strlen(s) != RYUW122_CPIN_HEX_LEN) {
        return false;
    }
    for (size_t i = 0; i < RYUW122_CPIN_HEX_LEN; i++) {
        if (!isxdigit((unsigned char)s[i])) {
            return false;
        }
    }
    return true;
}

const char *ryuw122_config_role_suffix(ryuw122_role_t role)
{
    return role == RYUW122_ROLE_ANCHOR ? "-anchor" : "-tag";
}

esp_err_t ryuw122_config_load(ryuw122_config_t *out)
{
    if (!out) {
        return ESP_ERR_INVALID_ARG;
    }
    ryuw122_config_defaults(out);

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return ESP_OK;
    }

    size_t len = sizeof(*out);
    err = nvs_get_blob(h, NVS_KEY, out, &len);
    nvs_close(h);
    if (err == ESP_OK && len == sizeof(*out)) {
        out->network_id[RYUW122_NETWORK_ID_LEN] = '\0';
        out->address[RYUW122_ADDRESS_LEN] = '\0';
        out->password[RYUW122_CPIN_HEX_LEN] = '\0';
        out->peer_address[RYUW122_ADDRESS_LEN] = '\0';
        out->anchor_payload[RYUW122_PAYLOAD_MAX] = '\0';
        out->tag_payload[RYUW122_PAYLOAD_MAX] = '\0';
        if (out->role > RYUW122_ROLE_ANCHOR) {
            out->role = RYUW122_ROLE_TAG;
        }
        if (out->range_interval_ms < 100U) {
            out->range_interval_ms = 100U;
        }
        memcpy(&s_active, out, sizeof(s_active));
        return ESP_OK;
    }
    memcpy(&s_active, out, sizeof(s_active));
    return ESP_OK;
}

esp_err_t ryuw122_config_save(const ryuw122_config_t *cfg)
{
    if (!cfg) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(h, NVS_KEY, cfg, sizeof(*cfg));
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        memcpy(&s_active, cfg, sizeof(s_active));
    }
    return err;
}

esp_err_t ryuw122_config_to_json(const ryuw122_config_t *cfg, char **json_out)
{
    if (!cfg || !json_out) {
        return ESP_ERR_INVALID_ARG;
    }
    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddStringToObject(root, "role", cfg->role == RYUW122_ROLE_ANCHOR ? "anchor" : "tag");
    cJSON_AddStringToObject(root, "networkId", cfg->network_id);
    cJSON_AddStringToObject(root, "address", cfg->address);
    cJSON_AddStringToObject(root, "password", cfg->password);
    cJSON_AddStringToObject(root, "peerAddress", cfg->peer_address);
    cJSON_AddStringToObject(root, "anchorPayload", cfg->anchor_payload);
    cJSON_AddStringToObject(root, "tagPayload", cfg->tag_payload);
    cJSON_AddNumberToObject(root, "rangeIntervalMs", cfg->range_interval_ms);
    cJSON_AddBoolToObject(root, "autoRange", cfg->auto_range);

    char *printed = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!printed) {
        return ESP_ERR_NO_MEM;
    }
    *json_out = printed;
    return ESP_OK;
}

static void copy_json_str(cJSON *obj, const char *key, char *dst, size_t dst_sz)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsString(item) && item->valuestring) {
        strncpy(dst, item->valuestring, dst_sz - 1U);
        dst[dst_sz - 1U] = '\0';
    }
}

esp_err_t ryuw122_config_from_json(const char *json, size_t len, ryuw122_config_t *cfg)
{
    if (!json || !cfg) {
        return ESP_ERR_INVALID_ARG;
    }
    cJSON *root = cJSON_ParseWithLength(json, len);
    if (!root) {
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *role = cJSON_GetObjectItemCaseSensitive(root, "role");
    if (cJSON_IsString(role) && role->valuestring) {
        if (strcmp(role->valuestring, "anchor") == 0) {
            cfg->role = RYUW122_ROLE_ANCHOR;
        } else if (strcmp(role->valuestring, "tag") == 0) {
            cfg->role = RYUW122_ROLE_TAG;
        }
    }

    copy_json_str(root, "networkId", cfg->network_id, sizeof(cfg->network_id));
    copy_json_str(root, "address", cfg->address, sizeof(cfg->address));
    copy_json_str(root, "password", cfg->password, sizeof(cfg->password));
    copy_json_str(root, "peerAddress", cfg->peer_address, sizeof(cfg->peer_address));
    copy_json_str(root, "anchorPayload", cfg->anchor_payload, sizeof(cfg->anchor_payload));
    copy_json_str(root, "tagPayload", cfg->tag_payload, sizeof(cfg->tag_payload));

    cJSON *ms = cJSON_GetObjectItemCaseSensitive(root, "rangeIntervalMs");
    if (cJSON_IsNumber(ms)) {
        int v = (int)ms->valuedouble;
        if (v < 100) {
            v = 100;
        }
        if (v > 60000) {
            v = 60000;
        }
        cfg->range_interval_ms = (uint16_t)v;
    }

    cJSON *ar = cJSON_GetObjectItemCaseSensitive(root, "autoRange");
    if (cJSON_IsBool(ar)) {
        cfg->auto_range = cJSON_IsTrue(ar);
    }

    cJSON_Delete(root);

    if (!is_8byte_ascii(cfg->network_id) || !is_8byte_ascii(cfg->address)) {
        ESP_LOGE(TAG, "networkId/address must be 8 ASCII characters");
        return ESP_ERR_INVALID_ARG;
    }
    if (cfg->role == RYUW122_ROLE_ANCHOR && !is_8byte_ascii(cfg->peer_address)) {
        ESP_LOGE(TAG, "peerAddress must be 8 ASCII characters for anchor");
        return ESP_ERR_INVALID_ARG;
    }
    if (!is_hex32(cfg->password)) {
        ESP_LOGE(TAG, "password must be 32 hex digits");
        return ESP_ERR_INVALID_ARG;
    }
    if (strlen(cfg->anchor_payload) > RYUW122_PAYLOAD_MAX || strlen(cfg->tag_payload) > RYUW122_PAYLOAD_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

#if CONFIG_REGATTAONE_RYUW122_ENABLE

esp_err_t ryuw122_config_apply(const ryuw122_config_t *cfg)
{
    if (!cfg) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = ryuw122_uart_apply_role(cfg);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "UART not ready: %s", esp_err_to_name(err));
        return err;
    }

    char cmd[96];
    snprintf(cmd, sizeof(cmd), "AT+MODE=%d", cfg->role == RYUW122_ROLE_ANCHOR ? 1 : 0);
    ESP_RETURN_ON_ERROR(ryuw122_uart_at_cmd(cmd, 3000), TAG, "MODE");

    snprintf(cmd, sizeof(cmd), "AT+NETWORKID=%s", cfg->network_id);
    ESP_RETURN_ON_ERROR(ryuw122_uart_at_cmd(cmd, 3000), TAG, "NETWORKID");

    snprintf(cmd, sizeof(cmd), "AT+ADDRESS=%s", cfg->address);
    ESP_RETURN_ON_ERROR(ryuw122_uart_at_cmd(cmd, 3000), TAG, "ADDRESS");

    snprintf(cmd, sizeof(cmd), "AT+CPIN=%s", cfg->password);
    ESP_RETURN_ON_ERROR(ryuw122_uart_at_cmd(cmd, 3000), TAG, "CPIN");

    ryuw122_uart_set_ranging(cfg);
    ble_sen0140_uwb_refresh_advertise(cfg);
    memcpy(&s_active, cfg, sizeof(s_active));
    ESP_LOGI(TAG, "applied role=%s net=%s addr=%s peer=%s auto=%d interval=%u ms",
             cfg->role == RYUW122_ROLE_ANCHOR ? "anchor" : "tag", cfg->network_id, cfg->address,
             cfg->peer_address, (int)cfg->auto_range, (unsigned)cfg->range_interval_ms);
    return ESP_OK;
}

esp_err_t ryuw122_config_update(const ryuw122_config_t *cfg)
{
    ESP_RETURN_ON_ERROR(ryuw122_config_save(cfg), TAG, "save");
    return ryuw122_config_apply(cfg);
}

#else

esp_err_t ryuw122_config_apply(const ryuw122_config_t *cfg)
{
    (void)cfg;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t ryuw122_config_update(const ryuw122_config_t *cfg)
{
    (void)cfg;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
