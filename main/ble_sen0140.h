/*
 * NimBLE GATT: streams sen0140_sample_t for Chrome Web Bluetooth (see web/).
 * Service 0xFEF0: IMU notify 0xFEF1; LoRa TX write 0xFEF7 / LoRa RX notify 0xFEF8 (SX1262);
 * LoRa stats read/notify + stream gate write 0xFEFE (JSON, RAM session stats);
 * GPS NMEA notify 0xFEFD; UWB UART line notify 0xFEF9;
 * Meshtastic line notify 0xFEE5 / command write 0xFEE6 / stats JSON 0xFEE7;
 * RYUW122 AT write 0xFEFA (responses on FEF9); boat id read/write 0xFEFB (NVS).
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "sen0140_10dof.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_sen0140_init(void);
/** Notify subscribed centrals if connected; no-op otherwise. */
void ble_sen0140_notify_if_active(const sen0140_sample_t *sample);
/** One UTF-8 line from SX1262 LoRa RX (0xFEF8 notify). */
void ble_sen0140_lora_line_notify(const uint8_t *data, size_t len);
/** LoRa session stats JSON (0xFEFE notify; read returns same snapshot). */
void ble_sen0140_lora_stats_notify(const uint8_t *data, size_t len);
/** One UTF-8 NMEA line from GPS UART (0xFEFD notify). */
void ble_sen0140_gps_line_notify(const uint8_t *data, size_t len);
/** One UTF-8 line from RYUW122 UART (may be split across several notifies if long). */
void ble_sen0140_uwb_line_notify(const uint8_t *data, size_t len);
/** Meshtastic line log (0xFEE5 notify). */
void ble_sen0140_meshtastic_rx_notify(const uint8_t *data, size_t len);
/** Meshtastic roster/stats JSON (0xFEE7 notify; read returns same snapshot). */
void ble_sen0140_meshtastic_stats_notify(const uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif
