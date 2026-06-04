#include "gps_timebase.h"

#include <ctype.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "sdkconfig.h"

static const char *TAG = "gps_time";

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

static volatile uint32_t s_pps_count;
static volatile int64_t s_last_pps_esp_us;
static volatile int64_t s_utc_us_at_last_pps;
static volatile bool s_pps_seen;
static volatile bool s_utc_valid;

static int parse_two_digits(const char *p, int *out)
{
    if (!isdigit((unsigned char)p[0]) || !isdigit((unsigned char)p[1])) {
        return 0;
    }
    *out = (p[0] - '0') * 10 + (p[1] - '0');
    return 1;
}

static int parse_rmc_time_date(const char *time_f, const char *date_f, int64_t *utc_sec_out)
{
    if (!time_f || !date_f || strlen(time_f) < 6U || strlen(date_f) < 6U) {
        return 0;
    }
    int hh = 0;
    int mm = 0;
    int ss = 0;
    int dd = 0;
    int mo = 0;
    int yy = 0;
    if (!parse_two_digits(time_f, &hh) || !parse_two_digits(time_f + 2, &mm) || !parse_two_digits(time_f + 4, &ss)) {
        return 0;
    }
    if (!parse_two_digits(date_f, &dd) || !parse_two_digits(date_f + 2, &mo) || !parse_two_digits(date_f + 4, &yy)) {
        return 0;
    }
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mm > 59 || ss > 60) {
        return 0;
    }

    const int year = 2000 + yy;
    int y = year;
    int m = mo;
    if (m <= 2) {
        y--;
        m += 12;
    }
    const int era = y / 400;
    const int yoe = y - era * 400;
    const int doy = (153 * (m - 3) + 2) / 5 + dd - 1;
    const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const int64_t days = (int64_t)era * 146097 + doe - 719468;
    *utc_sec_out = days * 86400LL + (int64_t)hh * 3600LL + (int64_t)mm * 60LL + (int64_t)ss;
    return 1;
}

static bool nmea_sentence_type(const char *line, size_t len, const char *suffix)
{
    if (!line || len < 7U || line[0] != '$') {
        return false;
    }
    const size_t slen = strlen(suffix);
    if (len < 3U + slen) {
        return false;
    }
    return memcmp(line + 3, suffix, slen) == 0;
}

static const char *nmea_field(const char *line, int index)
{
    const char *p = line;
    int field = 0;
    while (*p && field < index) {
        if (*p == ',') {
            field++;
        }
        p++;
    }
    if (field != index) {
        return NULL;
    }
    return p;
}

static void snap_utc_from_rmc(int64_t utc_sec)
{
    portENTER_CRITICAL(&s_mux);
    const int64_t esp_now = esp_timer_get_time();
    if (s_pps_seen && s_last_pps_esp_us > 0) {
        const int64_t elapsed_us = esp_now - (int64_t)s_last_pps_esp_us;
        const int64_t elapsed_sec = elapsed_us / 1000000LL;
        s_utc_us_at_last_pps = utc_sec * 1000000LL - elapsed_sec * 1000000LL;
    } else {
        s_utc_us_at_last_pps = utc_sec * 1000000LL;
        s_last_pps_esp_us = esp_now;
    }
    s_utc_valid = true;
    portEXIT_CRITICAL(&s_mux);
    ESP_LOGI(TAG, "UTC sync from RMC: sec=%lld pps=%lu", (long long)utc_sec, (unsigned long)s_pps_count);
}

void gps_timebase_init(void)
{
    portENTER_CRITICAL(&s_mux);
    s_pps_count = 0;
    s_last_pps_esp_us = 0;
    s_utc_us_at_last_pps = 0;
    s_pps_seen = false;
    s_utc_valid = false;
    portEXIT_CRITICAL(&s_mux);
}

void IRAM_ATTR gps_timebase_on_pps_isr(int64_t esp_timer_us)
{
    portENTER_CRITICAL_ISR(&s_mux);
    s_pps_count++;
    s_last_pps_esp_us = esp_timer_us;
    s_pps_seen = true;
    if (s_utc_valid) {
        if (s_pps_count > 1U) {
            s_utc_us_at_last_pps += 1000000LL;
        }
    }
    portEXIT_CRITICAL_ISR(&s_mux);
}

void gps_timebase_feed_nmea(const char *line, size_t len)
{
    if (!line || len < 10U) {
        return;
    }
    if (!nmea_sentence_type(line, len, "RMC")) {
        return;
    }

    const char *status = nmea_field(line, 2);
    if (!status || status[0] != 'A') {
        return;
    }

    const char *time_f = nmea_field(line, 1);
    const char *date_f = nmea_field(line, 9);
    int64_t utc_sec = 0;
    if (!parse_rmc_time_date(time_f, date_f, &utc_sec)) {
        return;
    }

    portENTER_CRITICAL(&s_mux);
    if (s_utc_valid && s_pps_seen) {
        const int64_t estimate_sec = s_utc_us_at_last_pps / 1000000LL;
        const int64_t esp_now = esp_timer_get_time();
        const int64_t est_now_sec = estimate_sec + (esp_now - (int64_t)s_last_pps_esp_us) / 1000000LL;
        if (utc_sec >= est_now_sec - 1LL && utc_sec <= est_now_sec + 1LL) {
            portEXIT_CRITICAL(&s_mux);
            return;
        }
    }
    portEXIT_CRITICAL(&s_mux);

    snap_utc_from_rmc(utc_sec);
}

int64_t gps_timebase_now_us(void)
{
    portENTER_CRITICAL(&s_mux);
    const bool valid = s_utc_valid && s_pps_seen;
    const int64_t utc_pps = s_utc_us_at_last_pps;
    const int64_t pps_esp = s_last_pps_esp_us;
    portEXIT_CRITICAL(&s_mux);

    if (!valid || pps_esp <= 0) {
        return 0;
    }
    const int64_t now_esp = esp_timer_get_time();
    return utc_pps + (now_esp - pps_esp);
}

int64_t gps_timebase_utc_sec_at_pps(void)
{
    portENTER_CRITICAL(&s_mux);
    const int64_t us = s_utc_us_at_last_pps;
    portEXIT_CRITICAL(&s_mux);
    return us / 1000000LL;
}

uint32_t gps_timebase_pps_count(void)
{
    portENTER_CRITICAL(&s_mux);
    const uint32_t c = s_pps_count;
    portEXIT_CRITICAL(&s_mux);
    return c;
}

int64_t gps_timebase_last_pps_esp_us(void)
{
    portENTER_CRITICAL(&s_mux);
    const int64_t t = s_last_pps_esp_us;
    portEXIT_CRITICAL(&s_mux);
    return t;
}

bool gps_timebase_pps_locked(void)
{
    portENTER_CRITICAL(&s_mux);
    const bool v = s_pps_seen;
    portEXIT_CRITICAL(&s_mux);
    return v;
}

bool gps_timebase_utc_valid(void)
{
    portENTER_CRITICAL(&s_mux);
    const bool v = s_utc_valid && s_pps_seen;
    portEXIT_CRITICAL(&s_mux);
    return v;
}
