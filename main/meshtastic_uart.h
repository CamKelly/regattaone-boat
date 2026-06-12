#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** UART to Meshtastic companion (PROTO framing); feeds meshtastic_client. */
esp_err_t meshtastic_uart_start(void);

/** Write raw bytes to the Meshtastic module RX line. */
esp_err_t meshtastic_uart_write(const uint8_t *data, size_t len);
