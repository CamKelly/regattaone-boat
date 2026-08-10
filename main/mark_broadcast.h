#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Compact mark broadcast via Meshtastic companion UART (portnum PRIVATE_APP).
 * The SX1262 LoRa radio is managed by Meshtastic firmware, not this app.
 *
 * Wire format (18 bytes):
 *   magic "RM" (2) | ver=1 (1) | role 'P'|'S' (1) | uwb_addr BE u16 (2)
 *   | lat_e7 BE i32 (4) | lon_e7 BE i32 (4) | acc_cm BE u16 (2) | dist_cm BE u16 (2)
 * dist_cm = 0xFFFF means unknown / not measured.
 *
 * Port and Starboard both TX and RX: each opposing broadcast updates the
 * receiver's peer UWB address used for DWM3000 ranging (address may change).
 *
 * Boat devices do not broadcast. They learn Port/Starboard UWB addresses and
 * baseline distances from mark RX, and sniff UWB mark blinks passively for ToA
 * (see mark_blink / boat_tdoa). Boat↔mark distances come from the TDoA solve.
 */

#define MARK_BROADCAST_PKT_LEN 18U
#define MARK_BROADCAST_DIST_UNKNOWN 0xFFFFU

typedef enum {
    MARK_ROLE_PORT = 'P',
    MARK_ROLE_STARBOARD = 'S',
} mark_role_t;

typedef struct {
    mark_role_t role;
    uint16_t uwb_addr;
    int32_t lat_e7;  /**< degrees × 1e7 */
    int32_t lon_e7;
    uint16_t accuracy_cm;
    uint16_t dist_cm; /**< to opposite mark; MARK_BROADCAST_DIST_UNKNOWN if unknown */
    bool gps_valid;
    int64_t received_us;
    uint32_t from_node; /**< Meshtastic node num when known, else 0 */
} mark_broadcast_record_t;

/** Start TX task (port/starboard) and/or enable RX store (boat). */
esp_err_t mark_broadcast_start(void);

/** Handle a raw radio payload (SX1262 or Meshtastic PRIVATE_APP). */
void mark_broadcast_on_rx(const uint8_t *data, size_t len, uint32_t from_node);

/** Boat (or any listener): last heard port mark, or false if none. */
bool mark_broadcast_get_port(mark_broadcast_record_t *out);

/** Boat (or any listener): last heard starboard mark, or false if none. */
bool mark_broadcast_get_starboard(mark_broadcast_record_t *out);

/**
 * Boat: publish a passive TDoA fix (updates boat↔mark cm and notifies BLE).
 * Sends $PREGGEOM (distances) and $PREGTDOA (XY + deltas). No-op if not boat.
 */
void mark_broadcast_publish_boat_tdoa(uint32_t seq, bool ok, double x_m, double y_m, double residual_m,
                                      double delta_sp_m, double delta_rp_m, uint16_t boat_port_cm,
                                      uint16_t boat_starboard_cm, uint16_t boat_reference_cm,
                                      double reference_x_m, double reference_y_m);

#ifdef __cplusplus
}
#endif
