#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "dwmac.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Passive/Starboard synchronized UWB blinks for passive boat ToA sniffing.
 *
 * Port TX @ 1 Hz (role=P, seq++, Fixed_Delay in payload).
 * Starboard RX Port blink → hardware-delayed TX (role=S, same seq).
 * Boat RX-only: logs ToA per blink and paired dt when both halves of a seq arrive.
 *
 * Uses short 802.15.4 DATA frames (func MARK_BLINK_MSG) so existing frame
 * filtering accepts them. Does not change Meshtastic mark broadcasts.
 */
#define MARK_BLINK_MSG 0x31

/** Called from the DW3000 RX path. Returns true if the frame was a mark blink. */
bool mark_blink_try_handle(const struct rxbuf *rx);

/**
 * Start role-specific blink behaviour (requires DW3000 ranging already up).
 * Port: 1 Hz TX task. Starboard/Boat: RX handled via mark_blink_try_handle.
 */
esp_err_t mark_blink_start(void);

#ifdef __cplusplus
}
#endif
