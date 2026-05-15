#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

esp_err_t blues_notecard_init(i2c_master_bus_handle_t shared_bus_or_null);
/** JSON line must end with `\n`. On success `*response_out` is malloc'd; caller must free. */
esp_err_t blues_notecard_transaction(const char *json_line, size_t json_len, char **response_out);
