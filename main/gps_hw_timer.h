/*
 * 1 MHz GPTimer monotonic clock for PPS-synced UTC and TDMA slot alarms.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "driver/gptimer.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GPS_HW_TIMER_RESOLUTION_HZ 1000000U

/** Allocate the shared GPTimer (does not enable — register callbacks first). */
esp_err_t gps_hw_timer_init(void);

/** Enable and start the GPTimer (after gptimer_register_event_callbacks). */
esp_err_t gps_hw_timer_start(void);

/** Free-running count in microseconds (1 tick = 1 µs at 1 MHz). IRAM-safe. */
uint64_t gps_hw_timer_now_ticks(void);

/** Align GPTimer count to MCPWM-captured PPS value (call from PPS ISR). IRAM-safe. */
void gps_hw_timer_sync_to_capture(uint64_t cap_ticks);

/** Shared handle for TDMA one-shot alarms (NULL if not initialized). */
gptimer_handle_t gps_hw_timer_handle(void);

#ifdef __cplusplus
}
#endif
