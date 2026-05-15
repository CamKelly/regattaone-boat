/*
 * Program MSP430 FR devices over UART BSL (TI SLAU550 UART PI + ti_txt image).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Parse CCS/IAR-style TI-TXT and program via BSL (9600 8E1).
 * `txt` must be writable; caller sets `txt[txt_len] == '\\0'` (buffer sized txt_len + 1).
 * `strtok_r` mutates the buffer. Performs GPIO BSL entry (if enabled), optional mass erase,
 * RX password 32×0xFF, then RX data blocks. Restores application UART (115200 N81) and resumes bridge.
 */
esp_err_t msp430_bsl_flash_ti_txt(uint8_t *txt, size_t txt_len, bool mass_erase_first);

#ifdef __cplusplus
}
#endif
