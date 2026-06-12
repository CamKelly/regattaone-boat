#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** Start Meshtastic Client API task (UART PROTO framing). */
esp_err_t meshtastic_client_start(void);

/** Feed raw UART bytes from the companion module. */
void meshtastic_client_uart_rx(const uint8_t *data, size_t len);

/** Handle BLE write on 0xFEE6 (`send=<dest>\\n<text>`, `config=1`). */
esp_err_t meshtastic_client_ble_write(const uint8_t *data, size_t len);

/** Handle BLE write on 0xFEE7 (`stats=1` refresh). */
esp_err_t meshtastic_client_stats_write(const char *cmd, size_t len);

/** Format node roster + message stats JSON for 0xFEE7 read/notify. */
size_t meshtastic_client_format_json(char *out, size_t out_cap);

/** Push a stats JSON notify when subscribers are active. */
void meshtastic_client_request_stats_notify(void);
