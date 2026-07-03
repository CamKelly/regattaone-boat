#pragma once

#include "esp_err.h"

/** UART listener for REYAX RYUW122_Lite (AT / range lines) → BLE notify. */
esp_err_t ryuw122_uart_start(void);
/** Write bytes to module RX (BLE GATT 0xFEFA or firmware). CRLF should be included for AT commands. */
esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len);

/**
 * Apply default RYUW122 AT profile once Meshtastic node num is known (anchor/tag per device type).
 * Safe to call repeatedly; no-op after success or when prerequisites are missing.
 */
void ryuw122_provision_try(void);
/** Clear provision state and re-run AT setup for the current device type (e.g. after BLE type change). */
void ryuw122_provision_on_device_type_changed(void);

/** True when TDMA allows UWB activity (same slot schedule as LoRa). */
bool ryuw122_tdma_can_use_now(void);
/** Microseconds until this device's TDMA TX window (-1 if UTC not synced). */
int64_t ryuw122_tdma_us_until_window(void);
