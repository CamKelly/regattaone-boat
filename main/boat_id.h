#pragma once

#include <stddef.h>

#include "esp_err.h"

/** User-assigned boat label stored in NVS (survives power cycle). */
#define BOAT_ID_MAX_LEN 32U
/** Max chars that fit in legacy connectable ADV with service UUID 0xFEF0. */
#define BOAT_ID_BLE_NAME_MAX_LEN 20U

#define BOAT_ID_DEFAULT_BLE_NAME "RegattaOne-Boat"

/** Load boat id from NVS. Call once after `nvs_flash_init`. */
esp_err_t boat_id_init(void);

/** Current id (empty string if unset). */
const char *boat_id_get(void);

/** Name shown in BLE scan / GAP: custom id if set, else BOAT_ID_DEFAULT_BLE_NAME. */
const char *boat_id_ble_name(void);

/** Validate, persist to NVS, and update in-memory copy. */
esp_err_t boat_id_set(const char *id, size_t len);
