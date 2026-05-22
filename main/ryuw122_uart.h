#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "ryuw122_config.h"

/** UART listener for REYAX RYUW122_Lite (AT / range lines) → BLE notify. */
esp_err_t ryuw122_uart_start(void);
/** Write raw bytes to module RX (e.g. AT command from BLE GATT 0xFEFA). */
esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len);
/** Send AT command and wait for +OK (or +ERR) with timeout. */
esp_err_t ryuw122_uart_at_cmd(const char *cmd, uint32_t timeout_ms);
/** Apply stored config and start/stop auto-ranging task. */
esp_err_t ryuw122_uart_apply_role(const ryuw122_config_t *cfg);
void ryuw122_uart_set_ranging(const ryuw122_config_t *cfg);
