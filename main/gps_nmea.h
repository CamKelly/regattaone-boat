#pragma once

#include "esp_err.h"

/** Start GPS NMEA UART listener → BLE 0xFEFD notify. */
esp_err_t gps_nmea_start(void);
