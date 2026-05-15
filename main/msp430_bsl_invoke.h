/*
 * Hardware MSP430 FR BSL entry (TEST / RST sequence per TI SLAU550 §3.3.2).
 * Requires two GPIOs from the ESP32 to the target RST/NMI and TEST pins.
 */
#pragma once

#include "esp_err.h"
#include "sdkconfig.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * GPIO numbers for BSL invoke (outputs). Set either to -1 (`GPIO_NUM_NC`) to disable
 * the feature; BLE writes to 0xFEF3 then return “not supported”.
 *
 * ESP32-C3-MINI / XIAO ESP32C3: GPIO12–17 are tied to **integrated SPI flash** — never use
 * 15/16 as GPIO. Defaults here use D2/D3 (GPIO4/5); override if your PCB routes elsewhere.
 * Other targets: defaults avoid GPIO10/11 (I2C) and GPIO17/18 (MSP430 UART bridge).
 */
#if CONFIG_IDF_TARGET_ESP32C3
#ifndef MSP430_BSL_RST_GPIO_NUM
#define MSP430_BSL_RST_GPIO_NUM 4
#endif
#ifndef MSP430_BSL_TEST_GPIO_NUM
#define MSP430_BSL_TEST_GPIO_NUM 5
#endif
#else
#ifndef MSP430_BSL_RST_GPIO_NUM
#define MSP430_BSL_RST_GPIO_NUM 15
#endif
#ifndef MSP430_BSL_TEST_GPIO_NUM
#define MSP430_BSL_TEST_GPIO_NUM 16
#endif
#endif

/** Configure RST/TEST as outputs (idle: RST released high, TEST low). Safe to call once at boot. */
esp_err_t msp430_bsl_gpio_init(void);

/** True if both GPIOs are enabled and initialized. */
bool msp430_bsl_invoke_ready(void);

/**
 * Run the shared-JTAG-pin BSL entry waveform (Figure 3-2, SLAU550).
 * After success, talk to BSL at 9600 8E1 on the MSP430 UART pins — not the application baud.
 */
esp_err_t msp430_bsl_invoke_hardware(void);

/**
 * Hold RST and TEST at explicit levels (scope / wiring check). Does not run BSL entry.
 * Idle after boot is RST released high, TEST low — use `msp430_bsl_gpio_idle_levels()`.
 */
esp_err_t msp430_bsl_gpio_manual_levels(bool rst_high, bool test_high);

/** Restore default idle drive: RST high, TEST low (same as after `msp430_bsl_gpio_init`). */
esp_err_t msp430_bsl_gpio_idle_levels(void);

#ifdef __cplusplus
}
#endif
