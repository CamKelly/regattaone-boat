#pragma once

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Drop partially-uploaded image (e.g. on BLE disconnect). */
void msp430_fw_upload_abort(void);

/**
 * BLE framing for characteristic 0xFEF4 (single write per ATT PDU):
 * - 0x01 + u32_le total_size → allocate upload buffer
 * - 0x02 + u16_le chunk_len + chunk bytes → append
 * - 0x03 + u8 flags (bit0 = mass erase before program) → flash in worker task
 * - 0x04 → abort upload
 */
esp_err_t msp430_fw_upload_ble_packet(const uint8_t *data, uint16_t len);

#ifdef __cplusplus
}
#endif
