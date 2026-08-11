#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t addr;
    uint16_t panid;
    uint16_t antenna_delay;
    uint32_t twr_delay_us;
    uint32_t registration_interval_ms;
    uint32_t grant_duration_ms;
    uint32_t inactivity_timeout_ms;
    uint32_t baseline_max_age_ms;
    uint8_t max_missed_grants;
    uint8_t baseline_retries;
    uint8_t boat_range_retries;
    bool detailed_ranging_logs;
    bool scheduler_paused;
    /** Legacy beacon task gate; retained false while old compatibility code is linked. */
    bool anchor_twr;
} dw3000_config_t;

/** Load from NVS (Kconfig defaults when unset). Call before dw3000_ranging_init(). */
esp_err_t dw3000_config_init(void);

const dw3000_config_t *dw3000_config_get(void);

/** Validate, persist to NVS, update in-memory copy. Does not apply to radio. */
esp_err_t dw3000_config_set(const dw3000_config_t *cfg);

/** Parse a partial DWM3000/start-line configuration JSON object. */
bool dw3000_config_from_json(const char *json, size_t len, dw3000_config_t *out);

/** Format current config as JSON (no trailing newline). Returns bytes written or 0. */
size_t dw3000_config_format_json(char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif
