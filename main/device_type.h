#pragma once

#include <stddef.h>
#include <stdbool.h>

#include "esp_err.h"

/**
 * Regatta device classification (persisted in NVS, BLE 0xFEFC).
 *
 * Describes where the device sits in the course / fleet, independent of radio hardware.
 * Ranging stacks (REYAX RYUW122, DWM3000, …) map these types to anchor/tag roles as needed.
 *
 *   Port / Starboard / Waypoint     — mark or mobile node with tag role
 *   *_anchor variants               — same mark + anchor role (dual-role)
 *   Boat                            — primary vessel; anchor role only
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

/** True when this device acts as an anchor in a range network (boat, *_anchor). */
bool device_type_has_anchor_role(device_type_t type);

/** True when this device acts as a tag in a range network (all except boat-only). */
bool device_type_has_tag_role(device_type_t type);
