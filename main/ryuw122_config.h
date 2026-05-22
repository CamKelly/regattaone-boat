#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** REYAX RYUW122 role (AT+MODE). */
typedef enum {
    RYUW122_ROLE_TAG = 0,
    RYUW122_ROLE_ANCHOR = 1,
} ryuw122_role_t;

#define RYUW122_NETWORK_ID_LEN 8U
#define RYUW122_ADDRESS_LEN    8U
#define RYUW122_CPIN_HEX_LEN   32U
#define RYUW122_PAYLOAD_MAX    12U

typedef struct {
    ryuw122_role_t role;
    char network_id[RYUW122_NETWORK_ID_LEN + 1];
    char address[RYUW122_ADDRESS_LEN + 1];
    /** 32 hex digits (AES-128 key), no spaces. */
    char password[RYUW122_CPIN_HEX_LEN + 1];
    /** Tag address polled by anchor (AT+ANCHOR_SEND). */
    char peer_address[RYUW122_ADDRESS_LEN + 1];
    char anchor_payload[RYUW122_PAYLOAD_MAX + 1];
    char tag_payload[RYUW122_PAYLOAD_MAX + 1];
    uint16_t range_interval_ms;
    bool auto_range;
} ryuw122_config_t;

/** Load from NVS or menuconfig defaults. */
esp_err_t ryuw122_config_load(ryuw122_config_t *out);

/** Persist to NVS. */
esp_err_t ryuw122_config_save(const ryuw122_config_t *cfg);

/** Serialize current config to JSON (caller frees with free()). */
esp_err_t ryuw122_config_to_json(const ryuw122_config_t *cfg, char **json_out);

/** Parse JSON from BLE/web; partial fields keep previous values. */
esp_err_t ryuw122_config_from_json(const char *json, size_t len, ryuw122_config_t *cfg);

/** Apply AT+MODE/NETWORKID/ADDRESS/CPIN; starts auto-ranging if enabled. */
esp_err_t ryuw122_config_apply(const ryuw122_config_t *cfg);

/** Stop ranging, apply new config, refresh BLE advertise name. */
esp_err_t ryuw122_config_update(const ryuw122_config_t *cfg);

/** Suffix for BLE name: "-anchor" or "-tag". */
const char *ryuw122_config_role_suffix(ryuw122_role_t role);
