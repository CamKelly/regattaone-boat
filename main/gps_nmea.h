/*
 * GPS NMEA 0183 — UART + PPS pin map.
 * Set in menuconfig: Component config → RegattaOne — GPS (NMEA 0183 UART + PPS).
 */
#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "sdkconfig.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GPS_UART_PORT_NUM CONFIG_GPS_UART_PORT_NUM
#define GPS_UART_BAUD CONFIG_GPS_UART_BAUD
#define GPS_UART_TX_GPIO CONFIG_GPS_UART_TX_GPIO
#define GPS_UART_RX_GPIO CONFIG_GPS_UART_RX_GPIO
#define GPS_PPS_GPIO CONFIG_GPS_PPS_GPIO

#if CONFIG_REGATTAONE_GPS_ENABLE

/** UART listener → BLE 0xFEFD NMEA line notify; PPS GPIO → $PREGPPS lines on same characteristic. */
esp_err_t gps_nmea_start(void);

#else

esp_err_t gps_nmea_start(void);

#endif /* CONFIG_REGATTAONE_GPS_ENABLE */

/** PPS pulse count since boot (0 if GPS or PPS disabled). */
uint32_t gps_pps_pulse_count(void);
/** Timestamp of last PPS edge (esp_timer_get_time() µs), or 0 if none yet. */
int64_t gps_pps_last_edge_us(void);

#ifdef __cplusplus
}
#endif
