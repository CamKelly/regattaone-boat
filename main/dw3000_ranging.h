#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * DW3000 (DWM3000) ranging / blink API for RegattaOne.
 *
 * Thin wrapper over the vendored libdeca stack. Marks (Port/Starboard) use
 * dw3000_range_to() for inter-mark DS-TWR. Boats are UWB-passive: they sniff
 * mark blinks for ToA and do not initiate or answer TWR.
 *
 * Enable with CONFIG_REGATTAONE_DW3000_ENABLE + CONFIG_DW3000_RANGING_ENABLE.
 */

/**
 * Async ranging result callback. Fires from the libdeca worker task.
 *  - peer_addr: 16-bit address of the other device.
 *  - dist_cm:   measured distance in centimetres (valid only when ok == true).
 *  - ok:        true on a successful measurement, false on TWR failure.
 */
typedef void (*dw3000_range_result_cb_t)(uint16_t peer_addr, uint16_t dist_cm,
                                         bool ok);

/**
 * Initialize the DW3000 hardware and the libdeca TWR stack and put the radio
 * into receive mode so this device can answer ranging requests.
 *
 * Must be called once after nvs/boat_id init. Safe to call only when
 * CONFIG_DW3000_RANGING_ENABLE is set; otherwise returns ESP_ERR_NOT_SUPPORTED.
 */
esp_err_t dw3000_ranging_init(void);

/** Re-apply NVS/runtime config to an initialized ranging stack. */
esp_err_t dw3000_ranging_apply_config(void);

/** This device's own 16-bit UWB address. */
uint16_t dw3000_ranging_self_addr(void);

/** UWB PAN id shared by all RegattaOne devices. */
uint16_t dw3000_ranging_panid(void);

/** Change the volatile short address (registration); does not write NVS. */
esp_err_t dw3000_ranging_set_runtime_addr(uint16_t addr);

/**
 * Register an async result callback. Pass NULL to clear. The callback is
 * invoked for both locally-initiated ranges and ranges initiated by peers
 * (i.e. whenever this device learns a distance to a peer).
 */
void dw3000_ranging_set_callback(dw3000_range_result_cb_t cb);

/**
 * Blocking two-way ranging to peer_addr.
 *
 * On success returns ESP_OK and writes the distance in centimetres to
 * *dist_cm. Returns:
 *   ESP_ERR_INVALID_STATE  - stack not initialized, or a range is in progress
 *   ESP_ERR_INVALID_ARG    - dist_cm is NULL
 *   ESP_ERR_TIMEOUT        - no result within timeout_ms
 *   ESP_FAIL               - TWR exchange failed (out of range / no reply)
 *
 * timeout_ms of 0 uses a sensible default. Only one range runs at a time.
 */
esp_err_t dw3000_range_to(uint16_t peer_addr, uint16_t *dist_cm,
                          uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif
