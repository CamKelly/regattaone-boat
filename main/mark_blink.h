#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "dwmac.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Three-anchor UWB superframe (Port = master clock).
 *
 * Port @ 1 Hz: delayed-TX sync+positioning beacon with master TX timestamp and
 * slot offsets for Starboard / Reference.
 * Starboard & Reference: estimate α/β from Port sync (propagation-corrected via
 * TWR baseline), then hardware-delayed positioning beacons on the master timeline.
 * Boat: RX-only sniff/log (position solve is a later step).
 *
 * Frame func MARK_BLINK_MSG (0x31). Payload version 2 (see mark_blink.c).
 */
#define MARK_BLINK_MSG 0x31

#define ANCHOR_ROLE_PORT 'P'
#define ANCHOR_ROLE_STARBOARD 'S'
#define ANCHOR_ROLE_REFERENCE 'R'

/** Unknown / not measured baseline in beacon geometry fields. */
#define ANCHOR_DIST_UNKNOWN 0xFFFFU

/** Called from the DW3000 RX path. Returns true if the frame was an anchor beacon. */
bool mark_blink_try_handle(const struct rxbuf *rx);

/**
 * Start role-specific behaviour (requires DW3000 ranging already up).
 * Port: 1 Hz master task. Starboard/Reference: sync from RX. Boat: sniff + watchdog.
 */
esp_err_t mark_blink_start(void);

/**
 * Push a measured baseline into the beacon geometry (cm).
 * Pass ANCHOR_DIST_UNKNOWN to leave a field unchanged.
 */
void mark_blink_set_geometry_cm(uint16_t dist_ps_cm, uint16_t dist_pr_cm, uint16_t dist_sr_cm);

#ifdef __cplusplus
}
#endif
