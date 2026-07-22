#include "gps_fix.h"

#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

/** Consumer GPS UERE ≈ 5 m (same as web estimateHorizontalAccuracyM). */
#define GPS_UERE_M 5.0f

static SemaphoreHandle_t s_mtx;
static gps_fix_t s_fix;

static void ensure_mtx(void)
{
    if (s_mtx == NULL) {
        s_mtx = xSemaphoreCreateMutex();
    }
}

static int split_fields(char *s, char **fields, int max_fields)
{
    int n = 0;
    fields[n++] = s;
    for (char *p = s; *p != '\0' && n < max_fields; p++) {
        if (*p == ',') {
            *p = '\0';
            fields[n++] = p + 1;
        }
    }
    return n;
}

/** NMEA ddmm.mmmm + N/S or E/W → degrees. */
static bool nmea_coord_to_deg(const char *raw, const char *hemi, bool is_lat, double *out_deg)
{
    if (raw == NULL || raw[0] == '\0' || hemi == NULL || hemi[0] == '\0' || out_deg == NULL) {
        return false;
    }
    char *end = NULL;
    const double v = strtod(raw, &end);
    if (end == raw || !isfinite(v)) {
        return false;
    }
    /* raw is ddmm.mmmm — degrees = floor(v/100), minutes = remainder. */
    const int whole = (int)(v / 100.0);
    const double minutes = v - (whole * 100.0);
    double deg = (double)whole + (minutes / 60.0);
    const char h = (char)toupper((unsigned char)hemi[0]);
    if (is_lat) {
        if (h == 'S') {
            deg = -deg;
        } else if (h != 'N') {
            return false;
        }
    } else {
        if (h == 'W') {
            deg = -deg;
        } else if (h != 'E') {
            return false;
        }
    }
    *out_deg = deg;
    return true;
}

static uint16_t accuracy_from_hdop(float hdop)
{
    if (!(hdop > 0.0f) || !isfinite(hdop)) {
        return 0;
    }
    const float m = hdop * GPS_UERE_M;
    const float cm = m * 100.0f;
    if (cm >= 65535.0f) {
        return 65535U;
    }
    return (uint16_t)(cm + 0.5f);
}

static void apply_gga(char **f, int n)
{
    if (n < 10) {
        return;
    }
    const int quality = atoi(f[6]);
    double lat = 0.0;
    double lon = 0.0;
    const bool have_ll = nmea_coord_to_deg(f[2], f[3], true, &lat) && nmea_coord_to_deg(f[4], f[5], false, &lon);
    float hdop = 0.0f;
    if (f[8][0] != '\0') {
        hdop = strtof(f[8], NULL);
    }

    ensure_mtx();
    if (s_mtx == NULL || xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
    s_fix.fix_quality = (uint8_t)(quality < 0 ? 0 : (quality > 255 ? 255 : quality));
    if (have_ll && quality > 0) {
        s_fix.valid = true;
        s_fix.lat_deg = lat;
        s_fix.lon_deg = lon;
        s_fix.hdop = hdop;
        s_fix.accuracy_cm = accuracy_from_hdop(hdop);
        s_fix.updated_us = (int64_t)esp_timer_get_time();
    } else if (quality == 0) {
        s_fix.valid = false;
    }
    xSemaphoreGive(s_mtx);
}

static void apply_rmc(char **f, int n)
{
    if (n < 7) {
        return;
    }
    const char status = (char)toupper((unsigned char)f[2][0]);
    if (status != 'A') {
        ensure_mtx();
        if (s_mtx != NULL && xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) == pdTRUE) {
            s_fix.valid = false;
            xSemaphoreGive(s_mtx);
        }
        return;
    }
    double lat = 0.0;
    double lon = 0.0;
    if (!nmea_coord_to_deg(f[3], f[4], true, &lat) || !nmea_coord_to_deg(f[5], f[6], false, &lon)) {
        return;
    }
    ensure_mtx();
    if (s_mtx == NULL || xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
    s_fix.valid = true;
    s_fix.lat_deg = lat;
    s_fix.lon_deg = lon;
    if (s_fix.fix_quality == 0U) {
        s_fix.fix_quality = 1U;
    }
    s_fix.updated_us = (int64_t)esp_timer_get_time();
    xSemaphoreGive(s_mtx);
}

static void apply_gsa(char **f, int n)
{
    if (n < 17) {
        return;
    }
    /* GSA: PDOP=f[15], HDOP=f[16], VDOP=f[17] (0-based). */
    if (n < 18 || f[16][0] == '\0') {
        return;
    }
    const float hdop = strtof(f[16], NULL);
    ensure_mtx();
    if (s_mtx == NULL || xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
    s_fix.hdop = hdop;
    s_fix.accuracy_cm = accuracy_from_hdop(hdop);
    xSemaphoreGive(s_mtx);
}

void gps_fix_feed_line(const char *line, size_t len)
{
    if (line == NULL || len < 6U) {
        return;
    }
    char tmp[128];
    if (len >= sizeof(tmp)) {
        len = sizeof(tmp) - 1U;
    }
    memcpy(tmp, line, len);
    tmp[len] = '\0';
    /* Strip checksum and CR/LF */
    char *star = strchr(tmp, '*');
    if (star != NULL) {
        *star = '\0';
    }
    for (char *p = tmp; *p; p++) {
        if (*p == '\r' || *p == '\n') {
            *p = '\0';
            break;
        }
    }
    if (tmp[0] != '$') {
        return;
    }
    /* Talker-agnostic: $GPGGA / $GNGGA / … */
    char *fields[24];
    const int n = split_fields(tmp, fields, 24);
    if (n < 2) {
        return;
    }
    const char *id = fields[0];
    if (strlen(id) < 6U) {
        return;
    }
    id += 3; /* skip $xx */
    if (strncmp(id, "GGA", 3) == 0) {
        apply_gga(fields, n);
    } else if (strncmp(id, "RMC", 3) == 0) {
        apply_rmc(fields, n);
    } else if (strncmp(id, "GSA", 3) == 0) {
        apply_gsa(fields, n);
    }
}

bool gps_fix_get(gps_fix_t *out)
{
    if (out == NULL) {
        return false;
    }
    ensure_mtx();
    if (s_mtx == NULL || xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
    *out = s_fix;
    const bool ok = s_fix.valid;
    xSemaphoreGive(s_mtx);
    return ok;
}
