/*
 * GPS PPS + NMEA UTC timebase for TDMA (LoRa / UWB).
 * Monotonic extrapolation between 1 Hz PPS edges (1 µs resolution).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize (call once before gps_nmea_start). */
void gps_timebase_init(void);

/** Legacy: PPS GPIO ISR + esp_timer_get_time() timestamp. IRAM-safe. */
void gps_timebase_on_pps_isr(int64_t esp_timer_us);

/** MCPWM-captured PPS count (µs ticks); syncs GPTimer. IRAM-safe. */
void gps_timebase_on_pps_hw_isr(uint64_t cap_ticks);

/** Feed a complete NMEA line (e.g. $GNRMC) to refine UTC second alignment. */
void gps_timebase_feed_nmea(const char *line, size_t len);

/**
 * Best estimate of UTC microseconds since Unix epoch (1970-01-01T00:00:00Z).
 * Returns 0 if PPS/NMEA sync not yet valid.
 */
int64_t gps_timebase_now_us(void);

/** UTC whole seconds at last PPS edge (valid when synced). */
int64_t gps_timebase_utc_sec_at_pps(void);

uint32_t gps_timebase_pps_count(void);
/** Monotonic µs at last PPS (esp_timer or GPTimer, depending on config). */
int64_t gps_timebase_last_pps_esp_us(void);
#if CONFIG_REGATTAONE_GPS_HW_CAPTURE
/** MCPWM latched capture count at last PPS (1 tick = 1 µs). */
uint32_t gps_timebase_last_pps_cap_ticks(void);
/** Interval between last two PPS captures (µs); 0 until second edge. */
uint32_t gps_timebase_last_pps_cap_delta_us(void);
#endif

/** True when at least one PPS received. */
bool gps_timebase_pps_locked(void);

/** True when UTC second alignment is trusted (valid RMC + PPS). */
bool gps_timebase_utc_valid(void);

#ifdef __cplusplus
}
#endif
