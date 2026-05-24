#pragma once

#include <stddef.h>

#include "esp_err.h"

/** Regatta device classification (persisted in NVS). */
typedef enum {
    DEVICE_TYPE_PORT = 0,
    DEVICE_TYPE_STARBOARD = 1,
    DEVICE_TYPE_FIXED_DGPS_MARK = 2,
    DEVICE_TYPE_WAYPOINT = 3,
    DEVICE_TYPE_BOAT = 4,
} device_type_t;

#define DEVICE_TYPE_STR_MAX 20U

esp_err_t device_type_init(void);

device_type_t device_type_get(void);

const char *device_type_to_string(device_type_t type);

/** Parse port | starboard | fixed_dgps_mark | waypoint | boat. */
bool device_type_from_string(const char *s, size_t len, device_type_t *out);

esp_err_t device_type_set(device_type_t type);
