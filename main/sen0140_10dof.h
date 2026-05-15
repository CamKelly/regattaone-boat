/*
 * DFRobot SEN0140 "10 DOF" breakout (per DigiKey / DFRobot docs):
 * ADXL345 accel, ITG-3200 gyro, HMC5883L mag, BMP085 or BMP280 baro — one I2C bus.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "sdkconfig.h"

/** One snapshot from all SEN0140 sub-sensors (after `sen0140_board_init`). */
typedef struct {
    bool adxl_ok;
    float ax, ay, az;
    bool itg_ok;
    float gx, gy, gz;
    bool mag_ok;
    int16_t mx, my, mz;
    bool baro_temp_ok;
    float temp_c;
    bool baro_press_ok;
    float press_hpa;
} sen0140_sample_t;

/**
 * I2C pins — set in menuconfig: Component config → RegattaOne — SEN0140 I2C pins
 * (defaults: XIAO ESP32-C3 → GPIO6/7 = D4/D5; other targets → GPIO10/11).
 */
#define SEN0140_I2C_PORT        I2C_NUM_0
#define SEN0140_I2C_SDA_GPIO    CONFIG_SEN0140_I2C_SDA_GPIO
#define SEN0140_I2C_SCL_GPIO    CONFIG_SEN0140_I2C_SCL_GPIO
#define SEN0140_I2C_FREQ_HZ     100000

esp_err_t sen0140_board_init(void);
/**
 * I2C master bus after `sen0140_board_init` runs (including when it returns
 * `ESP_ERR_NOT_FOUND` but the bus was created). Cast to `i2c_master_bus_handle_t`.
 */
void *sen0140_i2c_bus_handle(void);
void sen0140_read_sample(sen0140_sample_t *out);
void sen0140_print_sample_human(const sen0140_sample_t *s);
void sen0140_print_sample_csv(const sen0140_sample_t *s);
void sen0140_print_all_readings(void);
/** One I2C pass: human-readable lines plus a single `PLOT,...` CSV row for host tools. */
void sen0140_print_readings_with_plot_csv(void);
