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
#if CONFIG_REGATTAONE_SX1262_ENABLE
#include "sx1262_lora.h"
#endif
#include "driver/i2c_master.h"
#include "i2c_bus_mux.h"
#include "ryuw122_uart.h"
#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
#include "meshtastic_uart.h"
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
        "Bring-up: IMU %s | LoRa %s | UWB %s | Meshtastic %s",
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
#if CONFIG_REGATTAONE_RYUW122_ENABLE
        "on",
#else
        "off",
#endif
#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
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
        ESP_LOGW(TAG, "SEN0140 / I2C init failed: %s — BLE still starts", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "SEN0140 (10 DOF) ready. GPIO SDA=%d SCL=%d", SEN0140_I2C_SDA_GPIO, SEN0140_I2C_SCL_GPIO);
    }
#else
    const bool sen0140_ok = false;
#endif

    err = ble_sen0140_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "BLE init failed: %s", esp_err_to_name(err));
        return;
    }

#if CONFIG_REGATTAONE_RYUW122_ENABLE
    err = ryuw122_uart_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "RYUW122 UART: %s", esp_err_to_name(err));
    }
#endif

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
     err = meshtastic_uart_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Meshtastic UART: %s", esp_err_to_name(err));
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

#if CONFIG_REGATTAONE_SEN0140_ENABLE
     if (sen0140_ok) {
        const uint32_t stack = 4096;
        if (xTaskCreate(sensor_task, "sen0140", stack, NULL, 5, NULL) != pdPASS) {
            ESP_LOGE(TAG, "sensor task create failed");
        }
    } 
#endif
}
