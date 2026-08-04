#include "dw3000_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "dw3000_cfg";
static const char *NVS_NS = "boat";
static const char *KEY_ADDR = "dw_addr";
static const char *KEY_PAN = "dw_pan";
static const char *KEY_ANT = "dw_ant";
static const char *KEY_TWR = "dw_twr";
static const char *KEY_ATWR = "dw_atwr";

static dw3000_config_t s_cfg;

static dw3000_config_t default_config(void)
{
    dw3000_config_t d = {
        .addr = 0x0001,
        .panid = 0xDECA,
        .antenna_delay = 16368,
        .twr_delay_us = 2000,
        .anchor_twr = false,
    };
#if CONFIG_DW3000_RANGING_ENABLE
    d.addr = (uint16_t)CONFIG_DW3000_ADDR;
    d.panid = (uint16_t)CONFIG_DW3000_PANID;
    d.antenna_delay = (uint16_t)CONFIG_DW3000_ANTENNA_DELAY;
    d.twr_delay_us = (uint32_t)CONFIG_DW3000_TWR_PROCESSING_DELAY_US;
#endif
    return d;
}

static bool valid_config(const dw3000_config_t *cfg)
{
    if (cfg == NULL) {
        return false;
    }
    if (cfg->addr == 0U || cfg->addr == 0xFFFFU) {
        return false;
    }
    if (cfg->twr_delay_us < 300U || cfg->twr_delay_us > 20000U) {
        return false;
    }
    return true;
}

static bool parse_json_u32(const char *json, const char *key, uint32_t *out)
{
    char needle[24];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *p = strstr(json, needle);
    if (p == NULL) {
        return false;
    }
    p += strlen(needle);
    while (*p == ' ' || *p == '\t') {
        p++;
    }
    if (strncmp(p, "true", 4) == 0) {
        *out = 1U;
        return true;
    }
    if (strncmp(p, "false", 5) == 0) {
        *out = 0U;
        return true;
    }
    char *end = NULL;
    unsigned long v;
    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
        v = strtoul(p, &end, 16);
    } else {
        v = strtoul(p, &end, 10);
    }
    if (end == p) {
        return false;
    }
    *out = (uint32_t)v;
    return true;
}

bool dw3000_config_from_json(const char *json, size_t len, dw3000_config_t *out)
{
    if (json == NULL || out == NULL || len == 0U) {
        return false;
    }
    char tmp[160];
    if (len >= sizeof(tmp)) {
        return false;
    }
    memcpy(tmp, json, len);
    tmp[len] = '\0';

    dw3000_config_t cfg = *dw3000_config_get();
    uint32_t v;
    if (parse_json_u32(tmp, "addr", &v)) {
        cfg.addr = (uint16_t)v;
    }
    if (parse_json_u32(tmp, "pan", &v)) {
        cfg.panid = (uint16_t)v;
    }
    if (parse_json_u32(tmp, "ant", &v)) {
        cfg.antenna_delay = (uint16_t)v;
    }
    if (parse_json_u32(tmp, "twr", &v)) {
        cfg.twr_delay_us = v;
    }
    if (parse_json_u32(tmp, "anchor_twr", &v)) {
        cfg.anchor_twr = (v != 0U);
    }
    if (!valid_config(&cfg)) {
        return false;
    }
    *out = cfg;
    return true;
}

size_t dw3000_config_format_json(char *out, size_t out_cap)
{
    if (out == NULL || out_cap == 0U) {
        return 0U;
    }
    const dw3000_config_t *cfg = dw3000_config_get();
    int n = snprintf(out, out_cap,
                     "{\"addr\":%u,\"pan\":%u,\"ant\":%u,\"twr\":%lu,\"anchor_twr\":%u}",
                     (unsigned)cfg->addr, (unsigned)cfg->panid, (unsigned)cfg->antenna_delay,
                     (unsigned long)cfg->twr_delay_us, cfg->anchor_twr ? 1U : 0U);
    if (n < 0 || (size_t)n >= out_cap) {
        return 0U;
    }
    return (size_t)n;
}

esp_err_t dw3000_config_init(void)
{
    s_cfg = default_config();

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return ESP_OK;
    }

    uint16_t u16;
    uint32_t u32;
    uint8_t u8;
    if (nvs_get_u16(h, KEY_ADDR, &u16) == ESP_OK) {
        s_cfg.addr = u16;
    }
    if (nvs_get_u16(h, KEY_PAN, &u16) == ESP_OK) {
        s_cfg.panid = u16;
    }
    if (nvs_get_u16(h, KEY_ANT, &u16) == ESP_OK) {
        s_cfg.antenna_delay = u16;
    }
    if (nvs_get_u32(h, KEY_TWR, &u32) == ESP_OK) {
        s_cfg.twr_delay_us = u32;
    }
    if (nvs_get_u8(h, KEY_ATWR, &u8) == ESP_OK) {
        s_cfg.anchor_twr = (u8 != 0U);
    }
    nvs_close(h);

    if (!valid_config(&s_cfg)) {
        s_cfg = default_config();
        ESP_LOGW(TAG, "invalid NVS config — using defaults");
    } else {
        ESP_LOGI(TAG, "loaded addr=0x%04X pan=0x%04X ant=%u twr=%lu us anchor_twr=%d",
                 (unsigned)s_cfg.addr, (unsigned)s_cfg.panid, (unsigned)s_cfg.antenna_delay,
                 (unsigned long)s_cfg.twr_delay_us, (int)s_cfg.anchor_twr);
    }
    return ESP_OK;
}

const dw3000_config_t *dw3000_config_get(void)
{
    return &s_cfg;
}

esp_err_t dw3000_config_set(const dw3000_config_t *cfg)
{
    if (!valid_config(cfg)) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_u16(h, KEY_ADDR, cfg->addr);
    if (err == ESP_OK) {
        err = nvs_set_u16(h, KEY_PAN, cfg->panid);
    }
    if (err == ESP_OK) {
        err = nvs_set_u16(h, KEY_ANT, cfg->antenna_delay);
    }
    if (err == ESP_OK) {
        err = nvs_set_u32(h, KEY_TWR, cfg->twr_delay_us);
    }
    if (err == ESP_OK) {
        err = nvs_set_u8(h, KEY_ATWR, cfg->anchor_twr ? 1U : 0U);
    }
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        return err;
    }

    s_cfg = *cfg;
    ESP_LOGI(TAG, "saved addr=0x%04X pan=0x%04X ant=%u twr=%lu us anchor_twr=%d", (unsigned)s_cfg.addr,
             (unsigned)s_cfg.panid, (unsigned)s_cfg.antenna_delay, (unsigned long)s_cfg.twr_delay_us,
             (int)s_cfg.anchor_twr);
    return ESP_OK;
}
