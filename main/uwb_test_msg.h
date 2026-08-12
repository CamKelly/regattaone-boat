#pragma once

#include <stddef.h>
#include <stdint.h>

#include "dwmac.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Short-frame UWB test text (func 0x50). Max UTF-8 payload fits the 70-byte RX buffer. */
#define UWB_TEST_MSG_FUNC 0x50U
#define UWB_TEST_MSG_MAX_TEXT 48U

/**
 * Send a short-address data frame to dst (0xFFFF = broadcast) carrying UTF-8 text.
 * Does not write NVS. Fails if the radio is busy with TWR.
 */
esp_err_t uwb_test_msg_send(uint16_t dst, const char *text, size_t text_len);

/** RX path hook. Returns true when the frame was a test text message. */
bool uwb_test_msg_try_handle(const struct rxbuf *rx);

#ifdef __cplusplus
}
#endif
