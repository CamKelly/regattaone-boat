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

/** Initialize RadioLib HAL and SX1262 modem (LoRa). */
esp_err_t sx1262_lora_init(void);
/** Start background RX task (continuous receive). */
esp_err_t sx1262_lora_start(void);
/** Transmit a raw payload; resumes RX afterward. */
esp_err_t sx1262_lora_transmit(const uint8_t *data, size_t len);

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */

#ifdef __cplusplus
}
#endif
