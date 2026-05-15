/*
 * UART1 @ 115200 from MSP430 TX → ESP RX (cross-wired). Pins must match your dev board wiring.
 */
#pragma once

#include "driver/uart.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Same UART peripheral as `msp430_uart_rx.c` (UART1 by default). */
#define MSP430_BRIDGE_UART_NUM UART_NUM_1

esp_err_t msp430_uart_rx_start(void);

/** When false, the RX bridge task stops reading (for BSL programming). */
void msp430_uart_bridge_set_enabled(bool enable);

/** Reconfigure baud / parity without reinstalling the driver (115200 N81 vs 9600 E81). */
esp_err_t msp430_uart_apply_config(int baud_rate, uart_parity_t parity);

void msp430_uart_flush_rx(void);

#ifdef __cplusplus
}
#endif
