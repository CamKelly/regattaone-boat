#pragma once

#include "esp_err.h"

/** UART listener for REYAX RYUW122_Lite (AT / range lines) → BLE notify. */
esp_err_t ryuw122_uart_start(void);
