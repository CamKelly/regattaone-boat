#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "dwmac.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define START_LINE_PORT_ADDR 0x0001U
#define START_LINE_STARBOARD_ADDR 0x0002U
#define START_LINE_UNASSIGNED_ADDR 0x0000U

esp_err_t start_line_ranging_start(void);
bool start_line_ranging_try_handle(const struct rxbuf *rx);
bool start_line_ranging_allow_twr(const struct rxbuf *rx);
void start_line_ranging_on_twr_result(uint64_t src, uint64_t dst, uint16_t dist, uint16_t num);

/** Compact JSON snapshot for BLE/UI. */
size_t start_line_ranging_format_status(char *out, size_t cap);
uint16_t start_line_ranging_baseline_cm(void);
void start_line_ranging_config_changed(void);

#ifdef __cplusplus
}
#endif
