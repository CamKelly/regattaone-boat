/*
 * UTC-aligned TDMA slot schedule (requires gps_timebase PPS + RMC sync).
 * Slot index is derived from UTC microseconds so all nodes share the same frame.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#if CONFIG_REGATTAONE_TDMA_ENABLE

/** Slot width in microseconds (from menuconfig). */
int64_t tdma_slot_us(void);
/** Slots per frame. */
uint32_t tdma_num_slots(void);
/** This node's assigned slot (0 .. num_slots-1). */
uint32_t tdma_device_slot(void);

/** Global slot index at utc_us (same on all nodes). */
uint32_t tdma_slot_index(int64_t utc_us);

/** True if utc_us falls in this node's TX window (excluding guard bands). */
bool tdma_in_tx_window(int64_t utc_us);

/** True if now (UTC µs) is in this node's TX window. */
bool tdma_can_transmit_now(void);

/** Microseconds until start of this node's next TX window (0 if in window). */
int64_t tdma_us_until_tx_window(void);

/** Microseconds remaining in current slot (0 if not our slot). */
int64_t tdma_us_remaining_in_slot(void);

#else

static inline int64_t tdma_slot_us(void) { return 0; }
static inline uint32_t tdma_num_slots(void) { return 0; }
static inline uint32_t tdma_device_slot(void) { return 0; }
static inline uint32_t tdma_slot_index(int64_t utc_us) { (void)utc_us; return 0; }
static inline bool tdma_in_tx_window(int64_t utc_us) { (void)utc_us; return true; }
static inline bool tdma_can_transmit_now(void) { return true; }
static inline int64_t tdma_us_until_tx_window(void) { return 0; }
static inline int64_t tdma_us_remaining_in_slot(void) { return 0; }

#endif /* CONFIG_REGATTAONE_TDMA_ENABLE */

#ifdef __cplusplus
}
#endif
