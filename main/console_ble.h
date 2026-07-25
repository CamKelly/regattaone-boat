#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Mirror ESP_LOG (and related) console output to BLE notify 0xFEE8.
 * Keeps UART0 / idf.py monitor working via the previous vprintf.
 * Drop-on-backpressure when the queue is full or nothing is subscribed.
 */
esp_err_t console_ble_start(void);

#ifdef __cplusplus
}
#endif
