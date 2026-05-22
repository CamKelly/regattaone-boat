#pragma once

#include "esp_err.h"

/** UART listener for REYAX RYUW122_Lite (AT / range lines) → BLE notify. */
esp_err_t ryuw122_uart_start(void);
/** Write raw bytes to module RX (e.g. AT command from BLE GATT 0xFEFA). */
esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len);
