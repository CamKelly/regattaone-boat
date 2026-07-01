/*
 * I2C reads for DFRobot SEN0140 (10 DOF) and common mag substitutes:
 * ADXL345, ITG-3200, BMP085 / BMP280 baro, plus HMC5883L / QMC5883L / LIS3MDL / VCM5883L / AK8963.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "esp_check.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h" // IWYU pragma: keep
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "i2c_bus_mux.h"
#include "sen0140_10dof.h"

static const char *TAG = "sen0140";

/* 7-bit I2C addresses (as wired on typical DFRobot 10 DOF boards) */
#define ADDR_ADXL345    0x53U
#define ADDR_ADXL345_ALT 0x1DU
#define ADDR_ITG3200    0x68U
#define ADDR_HMC5883L   0x1EU
/** Many "HMC5883L" / GY-271 boards use QMC5883L at 0x0D instead. */
#define ADDR_QMC5883L   0x0DU
/** ST LIS3MDL (often 0x1E or 0x1C depending on SA1 / clone BOM). */
#define ADDR_LIS3MDL_HI 0x1EU
#define ADDR_LIS3MDL_LO 0x1CU
/**
 * VCM5883L default 7-bit address is 0x0C (datasheet: "Address is 0C").
 * Same slave address as many AK8963 breakouts — disambiguate by chip ID.
 */
#define ADDR_VCM5883L   0x0CU
#define VCM5883L_REG_CHIP_ID 0x0CU
#define VCM5883L_CHIP_ID     0x82U
/** AK8963 (WHO_AM_I @ reg 0x00 == 0x48) */
#define ADDR_AK8963_A   0x0CU
/** BMP180/BMP085; BMP280 when SDO → VDD */
#define ADDR_BMP085     0x77U
/** BMP280 when SDO → GND (Bosch datasheet) */
#define ADDR_BMP280_LO  0x76U
#define BMP280_CHIP_ID  0x58U

/**
 * i2c_master_probe waits this long per address when nothing ACKs. Keep moderate so a few
 * mag attempts do not dominate boot; the full 0x08–0x77 scan uses I2C_SCAN_PROBE_TIMEOUT_MS.
 */
#define I2C_PROBE_TIMEOUT_MS 40
/** Many probes in a row (diagnostic scan); keep timeouts modest so boot stays responsive. */
#define I2C_SCAN_PROBE_TIMEOUT_MS 20
/** Register read/write timeout — never use -1 (wait forever) or a stuck bus blocks app_main before BLE starts */
#define I2C_XFER_TIMEOUT_MS  120
/** After `i2c_new_master_bus`, wait before first traffic so SEN0140 sub-chips can exit power-on reset. */
#define SEN0140_I2C_BUS_SETTLE_MS 50

typedef enum {
    MAG_NONE = 0,
    MAG_HMC5883L,
    MAG_QMC5883L,
    MAG_LIS3MDL,
    MAG_VCM5883L,
    MAG_AK8963,
} mag_kind_t;

typedef enum {
    BARO_NONE = 0,
    BARO_BMP085,
    BARO_BMP280,
} baro_kind_t;

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_adxl;
static i2c_master_dev_handle_t s_itg;
static i2c_master_dev_handle_t s_mag;
static mag_kind_t s_mag_kind;
static i2c_master_dev_handle_t s_baro;
static baro_kind_t s_baro_kind;
static bool s_baro_ok;

static esp_err_t reg_write(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(dev, buf, sizeof(buf), I2C_XFER_TIMEOUT_MS);
}

static esp_err_t reg_read(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *out, size_t len)
{
    return i2c_master_transmit_receive(dev, &reg, 1, out, len, I2C_XFER_TIMEOUT_MS);
}

static esp_err_t add_dev(uint8_t addr, i2c_master_dev_handle_t *out_dev)
{
    i2c_device_config_t cfg = {
        .device_address = addr,
        .scl_speed_hz = SEN0140_I2C_FREQ_HZ,
    };
    return i2c_master_bus_add_device(s_bus, &cfg, out_dev);
}

static esp_err_t adxl345_init(void)
{
    uint8_t id = 0;
    esp_err_t err = reg_read(s_adxl, 0x00, &id, 1);
    if (err != ESP_OK || id != 0xE5) {
        return ESP_ERR_NOT_FOUND;
    }
    ESP_RETURN_ON_ERROR(reg_write(s_adxl, 0x2C, 0x0A), TAG, "BW_RATE");
    ESP_RETURN_ON_ERROR(reg_write(s_adxl, 0x2D, 0x08), TAG, "POWER_CTL measure");
    ESP_RETURN_ON_ERROR(reg_write(s_adxl, 0x31, 0x03), TAG, "DATA_FORMAT full-res +-16g");
    return ESP_OK;
}

static esp_err_t itg3200_init(void)
{
    ESP_RETURN_ON_ERROR(reg_write(s_itg, 0x3E, 0x00), TAG, "PWR_MGMT_1 wake");
    ESP_RETURN_ON_ERROR(reg_write(s_itg, 0x15, 0x07), TAG, "SMPLRT_DIV");
    /* FS_SEL=3 (2000 dps), DLPF_CFG=0 (256 Hz gyro bandwidth, 8 kHz internal rate) */
    ESP_RETURN_ON_ERROR(reg_write(s_itg, 0x16, 0x18), TAG, "DLPF_FS");
    return ESP_OK;
}

static esp_err_t hmc5883l_init(i2c_master_dev_handle_t dev)
{
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x00, 0x70), TAG, "HMC CRA");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x01, 0x20), TAG, "HMC CRB gain");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x02, 0x00), TAG, "HMC mode continuous");
    return ESP_OK;
}

static esp_err_t qmc5883l_init(i2c_master_dev_handle_t dev)
{
    /* CTRL1 first, then SET/RESET — order matches several reference drivers */
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x0A, 0x1D), TAG, "QMC CTRL1");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x0B, 0x00), TAG, "QMC CTRL2");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x09, 0x01), TAG, "QMC SET/RESET");
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

static esp_err_t lis3mdl_init(i2c_master_dev_handle_t dev)
{
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x20, 0x70), TAG, "LIS3 CTRL1");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x21, 0x00), TAG, "LIS3 CTRL2");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x22, 0x00), TAG, "LIS3 CTRL3 continuous");
    return ESP_OK;
}

/**
 * VCM5883L: reg 0x0B = control 1 (SET/RESET); reg 0x0A = control 2 (ODR, MODE).
 * Bits [7:4] of 0x0A must be 0100b; 0x41 matches datasheet I²C example (Normal, 200 Hz).
 */
static esp_err_t vcm5883l_init(i2c_master_dev_handle_t dev)
{
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x0B, 0x01), TAG, "VCM SET/RESET ctrl");
    vTaskDelay(pdMS_TO_TICKS(5));
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x0A, 0x41), TAG, "VCM normal mode");
    vTaskDelay(pdMS_TO_TICKS(15));
    return ESP_OK;
}

static esp_err_t ak8963_init(i2c_master_dev_handle_t dev)
{
    uint8_t wia = 0;
    if (reg_read(dev, 0x00, &wia, 1) != ESP_OK || wia != 0x48) {
        return ESP_ERR_NOT_FOUND;
    }
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x0A, 0x00), TAG, "AK8963 power down");
    vTaskDelay(pdMS_TO_TICKS(10));
    /* 16-bit output, continuous measurement mode 2 (100 Hz) */
    ESP_RETURN_ON_ERROR(reg_write(dev, 0x0A, 0x16), TAG, "AK8963 continuous");
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

static void mag_release(void)
{
    if (s_mag) {
        i2c_master_bus_rm_device(s_mag);
        s_mag = NULL;
    }
    s_mag_kind = MAG_NONE;
}

/** WHO_AM_I @ 0x0F == 0x3D */
static bool mag_try_lis3mdl(uint8_t addr)
{
    if (i2c_master_probe(s_bus, addr, I2C_PROBE_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    if (add_dev(addr, &s_mag) != ESP_OK) {
        return false;
    }
    uint8_t who = 0;
    if (reg_read(s_mag, 0x0F, &who, 1) != ESP_OK || who != 0x3D) {
        mag_release();
        return false;
    }
    if (lis3mdl_init(s_mag) != ESP_OK) {
        mag_release();
        return false;
    }
    s_mag_kind = MAG_LIS3MDL;
    ESP_LOGI(TAG, "Magnetometer: LIS3MDL @ 0x%02x", addr);
    return true;
}

static bool mag_try_hmc5883l(void)
{
    if (i2c_master_probe(s_bus, ADDR_HMC5883L, I2C_PROBE_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    if (add_dev(ADDR_HMC5883L, &s_mag) != ESP_OK) {
        return false;
    }
    if (hmc5883l_init(s_mag) != ESP_OK) {
        mag_release();
        return false;
    }
    s_mag_kind = MAG_HMC5883L;
    ESP_LOGI(TAG, "Magnetometer: HMC5883L @ 0x1E");
    return true;
}

static bool mag_try_qmc_at(uint8_t addr)
{
    if (i2c_master_probe(s_bus, addr, I2C_PROBE_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    if (add_dev(addr, &s_mag) != ESP_OK) {
        return false;
    }
    if (qmc5883l_init(s_mag) != ESP_OK) {
        mag_release();
        return false;
    }
    s_mag_kind = MAG_QMC5883L;
    ESP_LOGI(TAG, "Magnetometer: QMC5883L @ 0x%02x", addr);
    return true;
}

static bool mag_try_vcm5883l_at(uint8_t addr)
{
    if (i2c_master_probe(s_bus, addr, I2C_PROBE_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    if (add_dev(addr, &s_mag) != ESP_OK) {
        return false;
    }
    uint8_t id = 0;
    if (reg_read(s_mag, VCM5883L_REG_CHIP_ID, &id, 1) != ESP_OK || id != VCM5883L_CHIP_ID) {
        mag_release();
        return false;
    }
    if (vcm5883l_init(s_mag) != ESP_OK) {
        mag_release();
        return false;
    }
    s_mag_kind = MAG_VCM5883L;
    ESP_LOGI(TAG, "Magnetometer: VCM5883L @ 0x%02x", addr);
    return true;
}

static bool mag_try_ak8963_at(uint8_t addr)
{
    if (i2c_master_probe(s_bus, addr, I2C_PROBE_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    if (add_dev(addr, &s_mag) != ESP_OK) {
        return false;
    }
    if (ak8963_init(s_mag) != ESP_OK) {
        mag_release();
        return false;
    }
    s_mag_kind = MAG_AK8963;
    ESP_LOGI(TAG, "Magnetometer: AK8963 @ 0x%02x", addr);
    return true;
}

static void i2c_log_scan(void)
{
    char buf[160];
    size_t n = 0;
    bool any = false;
    int ret = snprintf(buf, sizeof(buf), "I2C scan (7-bit addrs that ACK):");
    if (ret > 0) {
        n = (size_t)ret;
    }
    for (unsigned addr = 0x08; addr < 0x78 && n + 5 < sizeof(buf); addr++) {
        /* Yield periodically; do not call esp_task_wdt_reset() from app_main — it is often
         * not subscribed to the task WDT ("task not found") and does not help here. */
        if ((addr & 0x0fU) == 0x08U) {
            vTaskDelay(pdMS_TO_TICKS(1));
        }
        if (i2c_master_probe(s_bus, addr, I2C_SCAN_PROBE_TIMEOUT_MS) == ESP_OK) {
            any = true;
            ret = snprintf(buf + n, sizeof(buf) - n, " 0x%02x", addr);
            if (ret > 0) {
                n += (size_t)ret;
            }
        }
    }
    if (!any && n + 8 < sizeof(buf)) {
        (void)snprintf(buf + n, sizeof(buf) - n, " (none)");
    }
    ESP_LOGI(TAG, "%s", buf);
}

/** Right after bus bring-up: distinguish NACK / timeout / invalid state from “silent” failures. */
static void i2c_log_probe_hints(void)
{
    static const uint8_t addrs[] = { ADDR_ADXL345, ADDR_ADXL345_ALT, ADDR_ITG3200, ADDR_BMP085,
                                     ADDR_BMP280_LO
#if CONFIG_REGATTAONE_SC16IS752_ENABLE
                                     ,
                                     CONFIG_SC16IS752_I2C_ADDR
#endif
    };
    for (unsigned i = 0; i < sizeof(addrs); i++) {
        esp_err_t e = i2c_master_probe(s_bus, addrs[i], I2C_PROBE_TIMEOUT_MS);
        ESP_LOGI(TAG, "I2C probe 0x%02x → %s", (unsigned)addrs[i], esp_err_to_name(e));
    }
}

static void mag_bus_init(void)
{
    mag_release();

    /* LIS3MDL is often placed at 0x1E on newer / substitute 10-DOF boards */
    if (mag_try_lis3mdl(ADDR_LIS3MDL_HI)) {
        return;
    }
    if (mag_try_hmc5883l()) {
        return;
    }
    if (mag_try_lis3mdl(ADDR_LIS3MDL_LO)) {
        return;
    }
    if (mag_try_qmc_at(ADDR_QMC5883L)) {
        return;
    }
    /* 0x0C: VCM5883L (chip id @ reg 0x0C == 0x82) before AK8963 (WHO_AM_I @ 0x00 == 0x48) */
    if (mag_try_vcm5883l_at(ADDR_VCM5883L)) {
        return;
    }
    if (mag_try_ak8963_at(ADDR_AK8963_A)) {
        return;
    }
    /* AK8963 at 0x0D if not a QMC5883L */
    if (mag_try_ak8963_at(ADDR_QMC5883L)) {
        return;
    }

    ESP_LOGW(TAG, "Magnetometer: no known mag chip found (see I2C scan below)");
    i2c_log_scan();
}

typedef struct {
    int16_t ac1, ac2, ac3;
    uint16_t ac4, ac5, ac6;
    int16_t b1, b2;
    int16_t mb, mc, md;
} bmp085_cal_t;

static bmp085_cal_t s_bmp_cal;

typedef struct {
    uint16_t dig_T1;
    int16_t dig_T2;
    int16_t dig_T3;
    uint16_t dig_P1;
    int16_t dig_P2;
    int16_t dig_P3;
    int16_t dig_P4;
    int16_t dig_P5;
    int16_t dig_P6;
    int16_t dig_P7;
    int16_t dig_P8;
    int16_t dig_P9;
} bmp280_cal_t;

static bmp280_cal_t s_bmp280_cal;
static int32_t s_bmp280_t_fine;

static int16_t bmp085_read16(i2c_master_dev_handle_t dev, uint8_t reg)
{
    uint8_t b[2];
    if (reg_read(dev, reg, b, 2) != ESP_OK) {
        return 0;
    }
    return (int16_t)((b[0] << 8) | b[1]);
}

static esp_err_t bmp085_load_cal(void)
{
    uint8_t id = 0;
    if (reg_read(s_baro, 0xD0, &id, 1) != ESP_OK || id != 0x55) {
        return ESP_ERR_NOT_FOUND;
    }
    s_bmp_cal.ac1 = bmp085_read16(s_baro, 0xAA);
    s_bmp_cal.ac2 = bmp085_read16(s_baro, 0xAC);
    s_bmp_cal.ac3 = bmp085_read16(s_baro, 0xAE);
    s_bmp_cal.ac4 = (uint16_t)bmp085_read16(s_baro, 0xB0);
    s_bmp_cal.ac5 = (uint16_t)bmp085_read16(s_baro, 0xB2);
    s_bmp_cal.ac6 = (uint16_t)bmp085_read16(s_baro, 0xB4);
    s_bmp_cal.b1 = bmp085_read16(s_baro, 0xB6);
    s_bmp_cal.b2 = bmp085_read16(s_baro, 0xB8);
    s_bmp_cal.mb = bmp085_read16(s_baro, 0xBA);
    s_bmp_cal.mc = bmp085_read16(s_baro, 0xBC);
    s_bmp_cal.md = bmp085_read16(s_baro, 0xBE);
    s_baro_ok = true;
    return ESP_OK;
}

static esp_err_t bmp085_read_ut(int32_t *ut)
{
    ESP_RETURN_ON_ERROR(reg_write(s_baro, 0xF4, 0x2E), TAG, "BMP085 start UT");
    vTaskDelay(pdMS_TO_TICKS(5));
    uint8_t raw[2];
    ESP_RETURN_ON_ERROR(reg_read(s_baro, 0xF6, raw, 2), TAG, "BMP085 read UT");
    *ut = ((int32_t)raw[0] << 8) | raw[1];
    return ESP_OK;
}

static esp_err_t bmp280_load_cal(i2c_master_dev_handle_t dev)
{
    uint8_t cal[24];
    ESP_RETURN_ON_ERROR(reg_read(dev, 0x88, cal, sizeof(cal)), TAG, "BMP280 read cal");
    s_bmp280_cal.dig_T1 = (uint16_t)cal[0] | ((uint16_t)cal[1] << 8);
    s_bmp280_cal.dig_T2 = (int16_t)((uint16_t)cal[2] | ((uint16_t)cal[3] << 8));
    s_bmp280_cal.dig_T3 = (int16_t)((uint16_t)cal[4] | ((uint16_t)cal[5] << 8));
    s_bmp280_cal.dig_P1 = (uint16_t)cal[6] | ((uint16_t)cal[7] << 8);
    s_bmp280_cal.dig_P2 = (int16_t)((uint16_t)cal[8] | ((uint16_t)cal[9] << 8));
    s_bmp280_cal.dig_P3 = (int16_t)((uint16_t)cal[10] | ((uint16_t)cal[11] << 8));
    s_bmp280_cal.dig_P4 = (int16_t)((uint16_t)cal[12] | ((uint16_t)cal[13] << 8));
    s_bmp280_cal.dig_P5 = (int16_t)((uint16_t)cal[14] | ((uint16_t)cal[15] << 8));
    s_bmp280_cal.dig_P6 = (int16_t)((uint16_t)cal[16] | ((uint16_t)cal[17] << 8));
    s_bmp280_cal.dig_P7 = (int16_t)((uint16_t)cal[18] | ((uint16_t)cal[19] << 8));
    s_bmp280_cal.dig_P8 = (int16_t)((uint16_t)cal[20] | ((uint16_t)cal[21] << 8));
    s_bmp280_cal.dig_P9 = (int16_t)((uint16_t)cal[22] | ((uint16_t)cal[23] << 8));
    return ESP_OK;
}

/** Temperature in 0.01 °C; sets `s_bmp280_t_fine` for pressure compensation (Bosch BMP280). */
static int32_t bmp280_compensate_temp(int32_t adc_T)
{
    int32_t var1 = ((((adc_T >> 3) - ((int32_t)s_bmp280_cal.dig_T1 << 1))) * (int32_t)s_bmp280_cal.dig_T2) >> 11;
    int32_t var2 = (((((adc_T >> 4) - (int32_t)s_bmp280_cal.dig_T1) *
                      ((adc_T >> 4) - (int32_t)s_bmp280_cal.dig_T1)) >>
                     12) *
                    (int32_t)s_bmp280_cal.dig_T3) >>
                   14;
    s_bmp280_t_fine = var1 + var2;
    return (s_bmp280_t_fine * 5 + 128) >> 8;
}

/** Returns pressure in Q24.8 fixed point: pascal = value / 256 (BMP280 datasheet §3.11.3). */
static uint32_t bmp280_compensate_press(int32_t adc_P)
{
    int64_t var1 = (int64_t)s_bmp280_t_fine - 128000;
    int64_t var2 = var1 * var1 * (int64_t)s_bmp280_cal.dig_P6;
    var2 = var2 + (var1 * (int64_t)s_bmp280_cal.dig_P5 << 17);
    var2 = var2 + ((int64_t)s_bmp280_cal.dig_P4 << 35);
    var1 = (var1 * var1 * (int64_t)s_bmp280_cal.dig_P3 >> 8) + (var1 * (int64_t)s_bmp280_cal.dig_P2 << 12);
    var1 = (((((int64_t)1 << 47) + var1)) * (int64_t)s_bmp280_cal.dig_P1) >> 33;
    if (var1 == 0) {
        return 0;
    }
    int64_t p = 1048576 - adc_P;
    p = (((p << 31) - var2) * 3125) / var1;
    var1 = ((int64_t)s_bmp280_cal.dig_P9 * (p >> 13) * (p >> 13)) >> 25;
    var2 = ((int64_t)s_bmp280_cal.dig_P8 * p) >> 19;
    p = ((p + var1 + var2) >> 8) + ((int64_t)s_bmp280_cal.dig_P7 << 4);
    return (uint32_t)p;
}

static esp_err_t bmp280_init(i2c_master_dev_handle_t dev)
{
    ESP_RETURN_ON_ERROR(bmp280_load_cal(dev), TAG, "BMP280 cal");
    ESP_RETURN_ON_ERROR(reg_write(dev, 0xF5, 0x00), TAG, "BMP280 config");
    /* osrs_t x1, osrs_p x4, normal mode */
    ESP_RETURN_ON_ERROR(reg_write(dev, 0xF4, 0x2F), TAG, "BMP280 ctrl_meas");
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

static esp_err_t baro_try_at(uint8_t addr)
{
    if (s_baro) {
        i2c_master_bus_rm_device(s_baro);
        s_baro = NULL;
    }
    s_baro_kind = BARO_NONE;
    s_baro_ok = false;

    if (add_dev(addr, &s_baro) != ESP_OK) {
        return ESP_ERR_NOT_FOUND;
    }
    uint8_t id = 0;
    if (reg_read(s_baro, 0xD0, &id, 1) != ESP_OK) {
        i2c_master_bus_rm_device(s_baro);
        s_baro = NULL;
        return ESP_ERR_NOT_FOUND;
    }
    if (id == BMP280_CHIP_ID) {
        if (bmp280_init(s_baro) == ESP_OK) {
            s_baro_kind = BARO_BMP280;
            s_baro_ok = true;
            ESP_LOGI(TAG, "Barometer: BMP280 @ 0x%02x", addr);
            return ESP_OK;
        }
        i2c_master_bus_rm_device(s_baro);
        s_baro = NULL;
        return ESP_ERR_NOT_FOUND;
    }
    if (id == 0x55U) {
        if (bmp085_load_cal() == ESP_OK) {
            s_baro_kind = BARO_BMP085;
            ESP_LOGI(TAG, "Barometer: BMP085 @ 0x%02x", addr);
            return ESP_OK;
        }
        i2c_master_bus_rm_device(s_baro);
        s_baro = NULL;
        return ESP_ERR_NOT_FOUND;
    }
    i2c_master_bus_rm_device(s_baro);
    s_baro = NULL;
    return ESP_ERR_NOT_FOUND;
}

esp_err_t sen0140_board_init(void)
{
#if !CONFIG_REGATTAONE_SEN0140_ENABLE
    return ESP_ERR_NOT_SUPPORTED;
#else
    ESP_LOGI(TAG, "I2C bus new: idf_target=%s port=%d SDA=GPIO%d SCL=GPIO%d %u Hz",
             CONFIG_IDF_TARGET, (int)SEN0140_I2C_PORT, SEN0140_I2C_SDA_GPIO, SEN0140_I2C_SCL_GPIO,
             (unsigned)SEN0140_I2C_FREQ_HZ);
#if CONFIG_IDF_TARGET_ESP32C3
    ESP_LOGI(TAG,
             "Seeed XIAO ESP32-C3: SoC GPIO6 = PCB pad D4 (SDA), GPIO7 = pad D5 (SCL). "
             "Pad D6 is UART TX (GPIO21), not GPIO6 — if every probe times out, re-check you used D4/D5.");
#endif

    i2c_master_bus_config_t bus_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = SEN0140_I2C_PORT,
        .scl_io_num = SEN0140_I2C_SCL_GPIO,
        .sda_io_num = SEN0140_I2C_SDA_GPIO,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s_bus), TAG, "i2c bus");
    vTaskDelay(pdMS_TO_TICKS(SEN0140_I2C_BUS_SETTLE_MS));
    i2c_log_probe_hints();

    s_adxl = NULL;
    uint8_t adxl_addr_ok = 0;
    if (add_dev(ADDR_ADXL345, &s_adxl) == ESP_OK) {
        if (adxl345_init() == ESP_OK) {
            adxl_addr_ok = ADDR_ADXL345;
        } else {
            i2c_master_bus_rm_device(s_adxl);
            s_adxl = NULL;
        }
    }
    if (!s_adxl && add_dev(ADDR_ADXL345_ALT, &s_adxl) == ESP_OK) {
        if (adxl345_init() == ESP_OK) {
            adxl_addr_ok = ADDR_ADXL345_ALT;
        } else {
            i2c_master_bus_rm_device(s_adxl);
            s_adxl = NULL;
        }
    }
    if (s_adxl && adxl_addr_ok != 0) {
        ESP_LOGI(TAG, "Accelerometer: ADXL345 @ 0x%02x", adxl_addr_ok);
    } else {
        ESP_LOGW(TAG, "ADXL345 not found (check SDA/SCL GPIOs, wiring, 3V3)");
    }

    s_itg = NULL;
    if (add_dev(ADDR_ITG3200, &s_itg) == ESP_OK && itg3200_init() == ESP_OK) {
        ESP_LOGI(TAG, "Gyroscope: ITG-3200 @ 0x%02x", ADDR_ITG3200);
    } else {
        if (s_itg) {
            i2c_master_bus_rm_device(s_itg);
            s_itg = NULL;
        }
        ESP_LOGW(TAG, "ITG-3200 init failed (wrong board or I2C issue)");
    }

    mag_bus_init();

    s_baro = NULL;
    s_baro_kind = BARO_NONE;
    s_baro_ok = false;
    static const uint8_t k_baro_addrs[] = { ADDR_BMP085, ADDR_BMP280_LO };
    for (unsigned i = 0; i < sizeof(k_baro_addrs); i++) {
        if (baro_try_at(k_baro_addrs[i]) == ESP_OK) {
            break;
        }
    }
    if (!s_baro_ok) {
        ESP_LOGW(TAG, "No BMP085/BMP280 at 0x77 or 0x76");
    }

    if (!s_adxl && !s_itg && !s_mag && !s_baro_ok) {
        ESP_LOGW(TAG,
                 "No SEN0140 chips ACK — check SDA=GPIO%d SCL=GPIO%d (menuconfig), wiring, pull-ups, GND, 3V3",
                 (int)SEN0140_I2C_SDA_GPIO, (int)SEN0140_I2C_SCL_GPIO);
#if CONFIG_IDF_TARGET_ESP32C3
        ESP_LOGW(TAG,
                 "XIAO C3: defaults expect IMU SDA on pad D4 (GPIO6), SCL on D5 (GPIO7). "
                 "Wiring to D6/D7 is a different SoC pair and will fail every probe.");
#endif
        ESP_LOGE(TAG, "No SEN0140 sensors responded — fix I2C pins, wiring, or power (or disable SEN0140 in menuconfig)");
        return ESP_ERR_NOT_FOUND;
    }

    return ESP_OK;
#endif /* CONFIG_REGATTAONE_SEN0140_ENABLE */
}

static void sen0140_fill_sample(sen0140_sample_t *s)
{
    memset(s, 0, sizeof(*s));
    s->press_hpa = NAN;

    if (s_adxl) {
        uint8_t raw[6];
        esp_err_t adxl_err = ESP_FAIL;
        for (int attempt = 0; attempt < 3 && adxl_err != ESP_OK; attempt++) {
            if (attempt > 0) {
                esp_rom_delay_us(200);
            }
            adxl_err = reg_read(s_adxl, 0x32, raw, 6);
        }
        if (adxl_err == ESP_OK) {
            int16_t x = (int16_t)(raw[1] << 8 | raw[0]);
            int16_t y = (int16_t)(raw[3] << 8 | raw[2]);
            int16_t z = (int16_t)(raw[5] << 8 | raw[4]);
            s->adxl_ok = true;
            s->ax = x * 0.0039f;
            s->ay = y * 0.0039f;
            s->az = z * 0.0039f;
        } else {
            static TickType_t s_last_adxl_warn;
            const TickType_t now = xTaskGetTickCount();
            if (s_last_adxl_warn == 0 || (now - s_last_adxl_warn) > pdMS_TO_TICKS(5000)) {
                s_last_adxl_warn = now;
                ESP_LOGW(TAG, "ADXL345 data read failed (%s) — I2C glitch, bus contention, or sensor",
                         esp_err_to_name(adxl_err));
            }
        }
    }

    if (s_itg) {
        uint8_t raw[6];
        if (reg_read(s_itg, 0x1D, raw, 6) == ESP_OK) {
            int16_t gx = (int16_t)(raw[0] << 8 | raw[1]);
            int16_t gy = (int16_t)(raw[2] << 8 | raw[3]);
            int16_t gz = (int16_t)(raw[4] << 8 | raw[5]);
            s->itg_ok = true;
            s->gx = gx / 14.375f;
            s->gy = gy / 14.375f;
            s->gz = gz / 14.375f;
        }
    }

    if (s_mag && s_mag_kind == MAG_HMC5883L) {
        uint8_t raw[6];
        if (reg_read(s_mag, 0x03, raw, 6) == ESP_OK) {
            s->mag_ok = true;
            s->mx = (int16_t)(raw[0] << 8 | raw[1]);
            s->mz = (int16_t)(raw[2] << 8 | raw[3]);
            s->my = (int16_t)(raw[4] << 8 | raw[5]);
        }
    } else if (s_mag && s_mag_kind == MAG_QMC5883L) {
        uint8_t raw[6];
        if (reg_read(s_mag, 0x00, raw, 6) == ESP_OK) {
            s->mag_ok = true;
            s->mx = (int16_t)(raw[0] | (raw[1] << 8));
            s->my = (int16_t)(raw[2] | (raw[3] << 8));
            s->mz = (int16_t)(raw[4] | (raw[5] << 8));
        }
    } else if (s_mag && s_mag_kind == MAG_LIS3MDL) {
        uint8_t raw[6];
        if (reg_read(s_mag, 0x28, raw, 6) == ESP_OK) {
            s->mag_ok = true;
            s->mx = (int16_t)(raw[0] | (raw[1] << 8));
            s->my = (int16_t)(raw[2] | (raw[3] << 8));
            s->mz = (int16_t)(raw[4] | (raw[5] << 8));
        }
    } else if (s_mag && s_mag_kind == MAG_VCM5883L) {
        uint8_t raw[6];
        if (reg_read(s_mag, 0x00, raw, 6) == ESP_OK) {
            s->mag_ok = true;
            s->mx = (int16_t)(raw[0] | (raw[1] << 8));
            s->my = (int16_t)(raw[2] | (raw[3] << 8));
            s->mz = (int16_t)(raw[4] | (raw[5] << 8));
        }
    } else if (s_mag && s_mag_kind == MAG_AK8963) {
        uint8_t raw[6];
        if (reg_read(s_mag, 0x03, raw, 6) == ESP_OK) {
            s->mag_ok = true;
            s->mx = (int16_t)(raw[0] | (raw[1] << 8));
            s->my = (int16_t)(raw[2] | (raw[3] << 8));
            s->mz = (int16_t)(raw[4] | (raw[5] << 8));
        }
    }

    if (s_baro_ok && s_baro_kind == BARO_BMP085) {
        int32_t ut;
        if (bmp085_read_ut(&ut) == ESP_OK) {
            int32_t x1 = (ut - (int32_t)s_bmp_cal.ac6) * (int32_t)s_bmp_cal.ac5 >> 15;
            int32_t md = (int32_t)s_bmp_cal.md;
            int32_t denom = x1 + md;
            if (denom == 0) {
                denom = 1;
            }
            int32_t x2 = ((int32_t)s_bmp_cal.mc << 11) / denom;
            int32_t b5 = x1 + x2;
            int32_t t_tenths = (b5 + 8) >> 4;
            s->baro_temp_ok = true;
            s->temp_c = t_tenths / 10.0f;
        }
    } else if (s_baro_ok && s_baro_kind == BARO_BMP280) {
        uint8_t raw[6];
        if (reg_read(s_baro, 0xF7, raw, 6) == ESP_OK) {
            int32_t adc_P =
                (int32_t)(((uint32_t)raw[0] << 12) | ((uint32_t)raw[1] << 4) | ((uint32_t)raw[2] >> 4));
            int32_t adc_T =
                (int32_t)(((uint32_t)raw[3] << 12) | ((uint32_t)raw[4] << 4) | ((uint32_t)raw[5] >> 4));
            int32_t t_centi = bmp280_compensate_temp(adc_T);
            uint32_t p_q24_8 = bmp280_compensate_press(adc_P);
            s->baro_temp_ok = true;
            s->baro_press_ok = true;
            s->temp_c = t_centi / 100.0f;
            s->press_hpa = ((float)p_q24_8 / 256.0f) / 100.0f;
        }
    }
}

void sen0140_print_sample_human(const sen0140_sample_t *s)
{
    return; // temporary
    if (s->adxl_ok) {
        printf("ADXL345 g (approx): X=%.2f Y=%.2f Z=%.2f\n", s->ax, s->ay, s->az);
    }

    if (s->itg_ok) {
        printf("ITG3200 dps: X=%.1f Y=%.1f Z=%.1f\n", s->gx, s->gy, s->gz);
    }

    if (s->mag_ok) {
        switch (s_mag_kind) {
        case MAG_HMC5883L:
            printf("HMC5883L raw: X=%d Y=%d Z=%d (regs X,Z,Y)\n", s->mx, s->my, s->mz);
            break;
        case MAG_QMC5883L:
            printf("QMC5883L raw: X=%d Y=%d Z=%d\n", s->mx, s->my, s->mz);
            break;
        case MAG_LIS3MDL:
            printf("LIS3MDL raw: X=%d Y=%d Z=%d\n", s->mx, s->my, s->mz);
            break;
        case MAG_VCM5883L:
            printf("VCM5883L raw: X=%d Y=%d Z=%d\n", s->mx, s->my, s->mz);
            break;
        case MAG_AK8963:
            printf("AK8963 raw: X=%d Y=%d Z=%d\n", s->mx, s->my, s->mz);
            break;
        default:
            break;
        }
    }

    if (s->baro_temp_ok && s_baro_kind == BARO_BMP085) {
        printf("BMP085: T=%.1f C\n", s->temp_c);
    } else if (s->baro_temp_ok && s->baro_press_ok) {
        printf("BMP280: T=%.2f C P=%.2f hPa\n", s->temp_c, s->press_hpa);
    }
}

void sen0140_print_sample_csv(const sen0140_sample_t *s)
{
    /* PLOT,ax,ay,az,gx,gy,gz,mx,my,mz,temp_c,press_hpa — nan if sensor missing */
/*     printf(
        "PLOT,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g\n",
        s->adxl_ok ? s->ax : NAN,
        s->adxl_ok ? s->ay : NAN,
        s->adxl_ok ? s->az : NAN,
        s->itg_ok ? s->gx : NAN,
        s->itg_ok ? s->gy : NAN,
        s->itg_ok ? s->gz : NAN,
        s->mag_ok ? (float)s->mx : NAN,
        s->mag_ok ? (float)s->my : NAN,
        s->mag_ok ? (float)s->mz : NAN,
        s->baro_temp_ok ? s->temp_c : NAN,
        s->baro_press_ok ? s->press_hpa : NAN);
 */}

void sen0140_print_all_readings(void)
{
    sen0140_sample_t s;
    sen0140_fill_sample(&s);
    sen0140_print_sample_human(&s);
}

void sen0140_print_readings_with_plot_csv(void)
{
    sen0140_sample_t s;
    sen0140_fill_sample(&s);
    sen0140_print_sample_human(&s);
    sen0140_print_sample_csv(&s);
}

void *sen0140_i2c_bus_handle(void)
{
    return (void *)s_bus;
}

void sen0140_read_sample(sen0140_sample_t *out)
{
    if (!out) {
        return;
    }
    i2c_bus_mux_lock();
    sen0140_fill_sample(out);
    i2c_bus_mux_unlock();
}
