#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

/** SC16IS752 UART channel (TXA/RXA = A, TXB/RXB = B). */
typedef enum {
    SC16IS752_CH_A = 0,
    SC16IS752_CH_B = 1,
} sc16is752_channel_t;

/** Bring up I2C device, optional RESET/IRQ GPIO, and configure both UART channels. */
esp_err_t sc16is752_init(void);

/** Block until RX data may be available (IRQ or poll timeout). */
void sc16is752_wait_rx(TickType_t timeout);

/** Read up to `max` bytes from a channel RX FIFO (caller holds i2c mux if needed). */
size_t sc16is752_read(sc16is752_channel_t ch, uint8_t *buf, size_t max);

/** Write bytes to a channel TX FIFO. */
esp_err_t sc16is752_write(sc16is752_channel_t ch, const uint8_t *data, size_t len);

/** True after sc16is752_init() succeeds. */
bool sc16is752_ready(void);

/** Drive RESET GPIO high before I2C bus scan (call before sen0140_board_init if sharing bus). */
void sc16is752_prepare_reset(void);
