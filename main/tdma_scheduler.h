/*
 * GPTimer one-shot alarms for TDMA TX window open/close (hardware-scheduled slots).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#if CONFIG_TDMA_GPTIMER_SCHEDULER

esp_err_t tdma_scheduler_init(void);

/** Called from MCPWM PPS ISR after timebase update (re-arm if UTC just became valid). */
void tdma_scheduler_on_pps_isr(void);

/** True between slot-open and slot-close GPTimer alarms. */
bool tdma_scheduler_in_window(void);

/** Arm the next open/close pair from current UTC (task context). */
void tdma_scheduler_arm_next(void);

#else

static inline esp_err_t tdma_scheduler_init(void) { return ESP_OK; }
static inline void tdma_scheduler_on_pps_isr(void) {}
static inline bool tdma_scheduler_in_window(void) { return false; }
static inline void tdma_scheduler_arm_next(void) {}

#endif

#ifdef __cplusplus
}
#endif
