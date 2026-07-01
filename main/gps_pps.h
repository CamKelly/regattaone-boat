#pragma once

#include "esp_err.h"

/** Start 1 Hz PPS GPIO capture and emit $PREGPPS lines on BLE 0xFEFD. No-op when GPS_PPS_GPIO is -1. */
esp_err_t gps_pps_start(void);
