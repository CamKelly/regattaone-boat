/*
 * SX1262 LoRa radio — SPI pin map for RadioLib / ESP-IDF.
 * Set in menuconfig: Component config → RegattaOne — SX1262 LoRa (SPI, RadioLib).
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "sdkconfig.h"

#ifdef __cplusplus
extern "C" {
#endif

#if CONFIG_REGATTAONE_SX1262_ENABLE

#include "tdma.h"

#define SX1262_SPI_HOST_NUM     CONFIG_SX1262_SPI_HOST_NUM
#define SX1262_SPI_MOSI_GPIO    CONFIG_SX1262_SPI_MOSI_GPIO
#define SX1262_SPI_MISO_GPIO    CONFIG_SX1262_SPI_MISO_GPIO
#define SX1262_SPI_SCLK_GPIO    CONFIG_SX1262_SPI_SCLK_GPIO
#define SX1262_SPI_CS_GPIO      CONFIG_SX1262_SPI_CS_GPIO
#define SX1262_RESET_GPIO       CONFIG_SX1262_RESET_GPIO
#define SX1262_DIO1_GPIO        CONFIG_SX1262_DIO1_GPIO
#define SX1262_BUSY_GPIO        CONFIG_SX1262_BUSY_GPIO
#define SX1262_SPI_FREQ_HZ      CONFIG_SX1262_SPI_FREQ_HZ
#define SX1262_FREQ_HZ          CONFIG_SX1262_FREQ_HZ
#define SX1262_TX_POWER_DBM     CONFIG_SX1262_TX_POWER_DBM

typedef enum {
    SX1262_LORA_STATUS_DISABLED = 0,
    SX1262_LORA_STATUS_INIT_FAILED,
    SX1262_LORA_STATUS_NOT_STARTED,
    SX1262_LORA_STATUS_READY,
} sx1262_lora_status_t;

/** Human-readable status for BLE / logs (static buffer). */
const char *sx1262_lora_status_text(void);

/** Push current status line to LoRa BLE notify (0xFEF8), if subscribed. */
void sx1262_lora_emit_status(void);

/** Call when the app enables LoRa line notifications. */
void sx1262_lora_on_line_notify_subscribed(void);

/** Initialize RadioLib HAL and SX1262 modem (LoRa). */
esp_err_t sx1262_lora_init(void);
/** Start background RX + CAD/CSMA TX queue tasks. */
esp_err_t sx1262_lora_start(void);

/**
 * Enqueue a TX payload. Optional BLE prefix: "TTL=<ms>\\n" then UTF-8 body.
 * @param ttl_ms 0 uses CONFIG_SX1262_TX_DEFAULT_TTL_MS.
 */
esp_err_t sx1262_lora_enqueue(const uint8_t *data, size_t len, uint32_t ttl_ms);

/** Enqueue; TX worker honors TDMA slot when enabled. */
esp_err_t sx1262_lora_transmit(const uint8_t *data, size_t len);
/** Enqueue with TDMA gate skipped in the TX worker (testing). */
esp_err_t sx1262_lora_transmit_unscheduled(const uint8_t *data, size_t len);

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */

#ifdef __cplusplus
}
#endif
