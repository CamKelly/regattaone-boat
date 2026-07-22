#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool valid;
    double lat_deg;
    double lon_deg;
    /** Horizontal accuracy estimate in centimetres (HDOP × 5 m UERE), 0 if unknown. */
    uint16_t accuracy_cm;
    float hdop;
    uint8_t fix_quality; /**< GGA quality: 0 = no fix */
    int64_t updated_us;
} gps_fix_t;

/** Feed one NMEA sentence (with or without trailing LF). Safe from the GPS task. */
void gps_fix_feed_line(const char *line, size_t len);

/** Copy the latest fix. Returns false if no valid fix yet. */
bool gps_fix_get(gps_fix_t *out);

#ifdef __cplusplus
}
#endif
