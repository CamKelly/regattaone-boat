#pragma once

#include <stddef.h>
#include <stdbool.h>

#include "esp_err.h"

/**
 * Regatta device classification (persisted in NVS, BLE 0xFEFC).
 *
 * UWB routing on SC16IS752 (when enabled):
 *   UART A (TXA/RXA) — ANCHOR RYUW122
 *   UART B (TXB/RXB) — TAG RYUW122
 *
 *   Boat                         → anchor only (A)
 *   Port / Starboard / Waypoint  → tag only (B)
 *   *_ANCHOR variants            → tag (B) + anchor (A)
 */
typedef enum {
    DEVICE_TYPE_PORT = 0,
    DEVICE_TYPE_PORT_ANCHOR = 1,
    DEVICE_TYPE_STARBOARD = 2,
    DEVICE_TYPE_STARBOARD_ANCHOR = 3,
    DEVICE_TYPE_WAYPOINT = 4,
    DEVICE_TYPE_WAYPOINT_ANCHOR = 5,
    DEVICE_TYPE_BOAT = 6,
} device_type_t;

#define DEVICE_TYPE_STR_MAX 24U

esp_err_t device_type_init(void);

device_type_t device_type_get(void);

const char *device_type_to_string(device_type_t type);

/** Parse port | port_anchor | starboard | … | boat (legacy fixed_dgps_mark → waypoint). */
bool device_type_from_string(const char *s, size_t len, device_type_t *out);

esp_err_t device_type_set(device_type_t type);

/** True when firmware should listen/write SC16IS752 UART A (anchor). */
bool device_type_uwb_use_anchor(device_type_t type);

/** True when firmware should listen/write SC16IS752 UART B (tag). */
bool device_type_uwb_use_tag(device_type_t type);
