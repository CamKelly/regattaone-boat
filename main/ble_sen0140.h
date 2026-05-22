/*
 * NimBLE GATT: streams sen0140_sample_t for Chrome Web Bluetooth (see web/).
 * Service 0xFEF0: IMU notify 0xFEF1; MSP430 UART notify 0xFEF2; BSL invoke 0xFEF3;
 * FW upload write 0xFEF4; flash status notify 0xFEF5; RST/TEST manual drive write 0xFEF6;
 * Notecard JSON write 0xFEF7; Notecard response notify 0xFEF8; UWB UART line notify 0xFEF9;
 * RYUW122 AT write 0xFEFA (responses on FEF9).
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "sen0140_10dof.h"

esp_err_t ble_sen0140_init(void);
/** Notify subscribed centrals if connected; no-op otherwise. */
void ble_sen0140_notify_if_active(const sen0140_sample_t *sample);
/** Forward raw UART bytes from MSP430 → ESP (chunk may split across several notifies). */
void ble_sen0140_uart_notify_chunk(const uint8_t *data, size_t len);
/** Chunked UTF-8 JSON lines from Blues Notecard (response to FEF7 write). */
void ble_sen0140_notecard_rsp_notify_chunk(const uint8_t *data, size_t len);
/** One UTF-8 line from RYUW122 UART (may be split across several notifies if long). */
void ble_sen0140_uwb_line_notify(const uint8_t *data, size_t len);
/** UTF-8 status line during MSP430 BSL programming (requires notify on 0xFEF5). */
void ble_sen0140_prog_status_notify(const char *msg);
