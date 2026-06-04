#pragma once

#include "esp_err.h"

/** UART listener for REYAX RYUW122_Lite (AT / range lines) → BLE notify. */
esp_err_t ryuw122_uart_start(void);
/** Write raw bytes to module RX (e.g. AT command from BLE GATT 0xFEFA). */
esp_err_t ryuw122_uart_write(const uint8_t *data, size_t len);
/** Send AT command and wait for +OK / +ERR (CRLF appended if missing). */
esp_err_t ryuw122_uart_at_cmd(const char *cmd, uint32_t timeout_ms);
/** Queue AT from BLE GATT write; worker runs ryuw122_uart_at_cmd and notifies 0xFEF9. */
esp_err_t ryuw122_uart_queue_ble_at(const uint8_t *data, size_t len);
