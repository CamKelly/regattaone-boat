/*
 * GPS PPS via MCPWM hardware capture (latched count at rising edge).
 */
#pragma once

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Init MCPWM capture on GPS_PPS_GPIO. Notifies task on each PPS edge.
 * Requires gps_hw_timer_init() first.
 */
esp_err_t gps_pps_capture_init(TaskHandle_t notify_task);

#ifdef __cplusplus
}
#endif
