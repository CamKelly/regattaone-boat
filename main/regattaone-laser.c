/*
 * SPDX-FileCopyrightText: 2010-2022 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: CC0-1.0
 */

#include <stdio.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h" // IWYU pragma: keep
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "ble_sen0140.h"
#include "boat_id.h"
#include "device_type.h"
#include "boat_note.h"
#include "presence_sync.h"
#if CONFIG_REGATTAONE_NOTECARD_ENABLE
#include "blues_notecard.h"
#endif
#if CONFIG_REGATTAONE_SX1262_ENABLE
#include "sx1262_lora.h"
#endif
#if CONFIG_REGATTAONE_GPS_ENABLE
#include "gps_nmea.h"
#endif
#include "driver/i2c_master.h"
#include "i2c_bus_mux.h"
#include "ryuw122_uart.h"
#if CONFIG_REGATTAONE_MSP430_ENABLE
#include "msp430_bsl_invoke.h"
#include "msp430_uart_rx.h"
#endif
#if CONFIG_REGATTAONE_SEN0140_ENABLE
#include "sen0140_10dof.h"
#endif

static const char *TAG = "main";

#define BLE_IMU_PERIOD_MS   20
#define UART_CSV_INTERVAL_MS 500

#if CONFIG_REGATTAONE_SEN0140_ENABLE
static void sensor_task(void *arg)
{
    (void)arg;
    TickType_t period = pdMS_TO_TICKS(BLE_IMU_PERIOD_MS);
    uint32_t uart_accum_ms = 0;

    for (;;) {
        sen0140_sample_t s;
        sen0140_read_sample(&s);
        ble_sen0140_notify_if_active(&s);

        uart_accum_ms += BLE_IMU_PERIOD_MS;
        if (uart_accum_ms >= UART_CSV_INTERVAL_MS) {
            uart_accum_ms = 0;
            sen0140_print_sample_human(&s);
            sen0140_print_sample_csv(&s);
//            printf("\n");
            fflush(stdout);
        }

        vTaskDelay(period);
    }
}
#endif /* CONFIG_REGATTAONE_SEN0140_ENABLE */

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    ESP_ERROR_CHECK(boat_id_init());
    ESP_ERROR_CHECK(device_type_init());

    ESP_LOGI(
        TAG,
        "Bring-up: IMU %s | LoRa %s | GPS %s | UWB %s | MSP430 %s",
#if CONFIG_REGATTAONE_SEN0140_ENABLE
        "on",
#else
        "off",
#endif
#if CONFIG_REGATTAONE_SX1262_ENABLE
        "on",
#else
        "off",
#endif
#if CONFIG_REGATTAONE_GPS_ENABLE
        "on",
#else
        "off",
#endif
#if CONFIG_REGATTAONE_RYUW122_ENABLE
        "on",
#else
        "off",
#endif
#if CONFIG_REGATTAONE_MSP430_ENABLE
        "on"
#else
        "off"
#endif
    );

    i2c_bus_mux_init();

    esp_err_t err;
#if CONFIG_REGATTAONE_SEN0140_ENABLE
    err = sen0140_board_init();
    const bool sen0140_ok = (err == ESP_OK);
    if (!sen0140_ok) {
#if CONFIG_REGATTAONE_MSP430_ENABLE
        ESP_LOGW(TAG, "SEN0140 / I2C init failed: %s — BLE + MSP430 UART still start", esp_err_to_name(err));
#else
        ESP_LOGW(TAG, "SEN0140 / I2C init failed: %s — BLE still starts", esp_err_to_name(err));
#endif
    } else {
        ESP_LOGI(TAG, "SEN0140 (10 DOF) ready. GPIO SDA=%d SCL=%d", SEN0140_I2C_SDA_GPIO, SEN0140_I2C_SCL_GPIO);
    }
#else
    const bool sen0140_ok = false;
#endif

#if CONFIG_REGATTAONE_MSP430_ENABLE
    err = msp430_bsl_gpio_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "MSP430 BSL GPIO init: %s", esp_err_to_name(err));
    }
#endif

    err = ble_sen0140_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "BLE init failed: %s", esp_err_to_name(err));
        return;
    }

#if CONFIG_REGATTAONE_NOTECARD_ENABLE
    {
#if CONFIG_REGATTAONE_SEN0140_ENABLE
        i2c_master_bus_handle_t bus = (i2c_master_bus_handle_t)sen0140_i2c_bus_handle();
#else
        i2c_master_bus_handle_t bus = NULL;
#endif
        err = blues_notecard_init(bus);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Blues Notecard init: %s", esp_err_to_name(err));
        } else {
            ESP_LOGI(TAG, "Blues Notecard I2C (%s bus)", bus ? "shared SEN0140" : "standalone");
            boat_notehub_report_async(BOAT_NOTE_BOOT);
            presence_sync_start();
        }
    }
#endif

#if CONFIG_REGATTAONE_RYUW122_ENABLE
    err = ryuw122_uart_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "RYUW122 UART: %s", esp_err_to_name(err));
    }
#endif

#if CONFIG_REGATTAONE_SX1262_ENABLE
    err = sx1262_lora_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SX1262 LoRa init: %s", esp_err_to_name(err));
    } else {
        err = sx1262_lora_start();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "SX1262 LoRa start: %s", esp_err_to_name(err));
        }
    }
#endif

#if CONFIG_REGATTAONE_GPS_ENABLE
    err = gps_nmea_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "GPS NMEA UART: %s", esp_err_to_name(err));
    }
#endif

#if CONFIG_REGATTAONE_MSP430_ENABLE
    err = msp430_uart_rx_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "MSP430 UART bridge failed: %s", esp_err_to_name(err));
        return;
    }
#endif

#if CONFIG_REGATTAONE_SEN0140_ENABLE
    if (sen0140_ok) {
        const uint32_t stack = 4096;
        if (xTaskCreate(sensor_task, "sen0140", stack, NULL, 5, NULL) != pdPASS) {
            ESP_LOGE(TAG, "sensor task create failed");
        }
    }
#endif
}
