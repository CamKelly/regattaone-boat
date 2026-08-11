#pragma once

#include <stddef.h>
#include <stdbool.h>

#include "esp_err.h"

/**
 * Regatta device classification (persisted in NVS, BLE 0xFEFC).
 *
 * Describes where the device sits in the course / fleet, independent of radio hardware.
 * Ranging stacks (DWM3000, …) map these types to anchor/tag roles as needed.
 *
 *   Port / Starboard — fixed start-line marks
 *   Boat             — dynamically registered DS-TWR initiator
 */
typedef enum {
    DEVICE_TYPE_PORT = 0,
    DEVICE_TYPE_STARBOARD = 1,
    DEVICE_TYPE_BOAT = 2,
    DEVICE_TYPE_REFERENCE = 3,
} device_type_t;

#define DEVICE_TYPE_STR_MAX 24U

esp_err_t device_type_init(void);

device_type_t device_type_get(void);

const char *device_type_to_string(device_type_t type);

/** Parse port | starboard | boat (legacy/reference values map to boat). */
bool device_type_from_string(const char *s, size_t len, device_type_t *out);

esp_err_t device_type_set(device_type_t type);

/** True when this device acts as an anchor in a range network (boat). */
bool device_type_has_anchor_role(device_type_t type);

/** True when this device acts as a tag in a range network (port, starboard, reference). */
bool device_type_has_tag_role(device_type_t type);

/** True for Port / Starboard. */
bool device_type_is_course_mark(device_type_t type);
