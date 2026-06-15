#pragma once

#include "esp_err.h"

/** UART listener for REYAX RYUW122_Lite (AT / range lines) → BLE notify. */
esp_err_t ryuw122_uart_start(void);
/** Write bytes to module RX (BLE GATT 0xFEFA or firmware). CRLF should be included for AT commands. */
esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len);

/** True when TDMA allows UWB activity (same slot schedule as LoRa). */
bool ryuw122_tdma_can_use_now(void);
/** Microseconds until this device's TDMA TX window (-1 if UTC not synced). */
int64_t ryuw122_tdma_us_until_window(void);
