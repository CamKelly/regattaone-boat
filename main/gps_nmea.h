/*
 * GPS NMEA 0183 — UART + PPS pin map.
 * Set in menuconfig: Component config → RegattaOne — GPS (NMEA 0183 UART + PPS).
 */
#pragma once

#include "esp_err.h"
#include "sdkconfig.h"

#ifdef __cplusplus
extern "C" {
#endif

#if CONFIG_REGATTAONE_GPS_ENABLE

#define GPS_UART_PORT_NUM       CONFIG_GPS_UART_PORT_NUM
#define GPS_UART_BAUD           CONFIG_GPS_UART_BAUD
#define GPS_UART_TX_GPIO        CONFIG_GPS_UART_TX_GPIO
#define GPS_UART_RX_GPIO        CONFIG_GPS_UART_RX_GPIO
#define GPS_PPS_GPIO            CONFIG_GPS_PPS_GPIO

/** UART listener → BLE 0xFEFD NMEA line notify. */
esp_err_t gps_nmea_start(void);

#endif /* CONFIG_REGATTAONE_GPS_ENABLE */

#ifdef __cplusplus
}
#endif
