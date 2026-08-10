#include "mark_broadcast.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE

#include "device_type.h"
#include "dw3000_config.h"
#include "gps_fix.h"

#include "ble_sen0140.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdio.h>
#include <string.h>

#if CONFIG_DW3000_RANGING_ENABLE
#include "dw3000_ranging.h"
#include "mark_blink.h"
#endif

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
#include "meshtastic_client.h"
#endif

static const char *TAG = "mark_bcast";

#define MARK_MAGIC0 'R'
#define MARK_MAGIC1 'M'
#define MARK_VER 1U

static SemaphoreHandle_t s_store_mtx;
static mark_broadcast_record_t s_port;
static mark_broadcast_record_t s_starboard;
static bool s_have_port;
static bool s_have_starboard;

/** Opposite mark UWB address learned from every opposing broadcast (or Kconfig). */
static uint16_t s_peer_uwb;
static bool s_peer_uwb_known;
static uint16_t s_last_dist_cm = MARK_BROADCAST_DIST_UNKNOWN;
static bool s_last_dist_ok;

/** Boat-only: boat↔mark distances filled later via passive ToA solve (null for now). */
static uint16_t s_boat_to_port_cm = MARK_BROADCAST_DIST_UNKNOWN;
static uint16_t s_boat_to_starboard_cm = MARK_BROADCAST_DIST_UNKNOWN;

static uint16_t self_uwb_addr(void)
{
#if CONFIG_DW3000_RANGING_ENABLE
    return dw3000_ranging_self_addr();
#else
    const dw3000_config_t *cfg = dw3000_config_get();
    return cfg != NULL ? cfg->addr : 0U;
#endif
}

static void peer_lock(void)
{
    if (s_store_mtx != NULL) {
        (void)xSemaphoreTake(s_store_mtx, portMAX_DELAY);
    }
}

static void peer_unlock(void)
{
    if (s_store_mtx != NULL) {
        xSemaphoreGive(s_store_mtx);
    }
}

/**
 * Port learns Starboard's UWB address (and vice versa) from every opposing
 * broadcast so ranging always targets the current peer address.
 */
static void update_opposite_peer_uwb(mark_role_t my_role, mark_role_t their_role, uint16_t their_uwb)
{
    if (their_uwb == 0U || their_uwb == self_uwb_addr()) {
        return;
    }
    const bool opposite =
        (my_role == MARK_ROLE_PORT && their_role == MARK_ROLE_STARBOARD) ||
        (my_role == MARK_ROLE_STARBOARD && their_role == MARK_ROLE_PORT);
    if (!opposite) {
        return;
    }

    peer_lock();
    const bool first = !s_peer_uwb_known;
    const uint16_t prev = s_peer_uwb;
    s_peer_uwb = their_uwb;
    s_peer_uwb_known = true;
    peer_unlock();

    if (first) {
        ESP_LOGI(TAG, "opposite mark UWB learned: 0x%04X (from %c broadcast)", their_uwb,
                 (char)their_role);
    } else if (prev != their_uwb) {
        ESP_LOGI(TAG, "opposite mark UWB updated: 0x%04X → 0x%04X (from %c broadcast)", prev,
                 their_uwb, (char)their_role);
    }
}

static void put_be16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}

static void put_be32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

static uint16_t get_be16(const uint8_t *p)
{
    return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static uint32_t get_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static int32_t deg_to_e7(double deg)
{
    const double scaled = deg * 1e7;
    if (scaled >= 2147483647.0) {
        return 2147483647;
    }
    if (scaled <= -2147483648.0) {
        return (int32_t)(-2147483647 - 1);
    }
    return (int32_t)(scaled >= 0.0 ? scaled + 0.5 : scaled - 0.5);
}

static bool encode_packet(mark_role_t role, uint16_t uwb, const gps_fix_t *fix, uint16_t dist_cm,
                          uint8_t out[MARK_BROADCAST_PKT_LEN])
{
    out[0] = MARK_MAGIC0;
    out[1] = MARK_MAGIC1;
    out[2] = MARK_VER;
    out[3] = (uint8_t)role;
    put_be16(out + 4, uwb);
    if (fix != NULL && fix->valid) {
        put_be32(out + 6, (uint32_t)deg_to_e7(fix->lat_deg));
        put_be32(out + 10, (uint32_t)deg_to_e7(fix->lon_deg));
        put_be16(out + 14, fix->accuracy_cm);
    } else {
        put_be32(out + 6, 0);
        put_be32(out + 10, 0);
        put_be16(out + 14, 0);
    }
    put_be16(out + 16, dist_cm);
    return true;
}

static bool mark_broadcast_decode(const uint8_t *data, size_t len, mark_broadcast_record_t *out)
{
    if (data == NULL || out == NULL || len < MARK_BROADCAST_PKT_LEN) {
        return false;
    }
    if (data[0] != MARK_MAGIC0 || data[1] != MARK_MAGIC1 || data[2] != MARK_VER) {
        return false;
    }
    if (data[3] != (uint8_t)MARK_ROLE_PORT && data[3] != (uint8_t)MARK_ROLE_STARBOARD) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    out->role = (mark_role_t)data[3];
    out->uwb_addr = get_be16(data + 4);
    out->lat_e7 = (int32_t)get_be32(data + 6);
    out->lon_e7 = (int32_t)get_be32(data + 10);
    out->accuracy_cm = get_be16(data + 14);
    out->dist_cm = get_be16(data + 16);
    out->gps_valid = !(out->lat_e7 == 0 && out->lon_e7 == 0 && out->accuracy_cm == 0);
    return true;
}

static void store_record(const mark_broadcast_record_t *rec)
{
    if (s_store_mtx == NULL || xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
    if (rec->role == MARK_ROLE_PORT) {
        s_port = *rec;
        s_have_port = true;
    } else {
        s_starboard = *rec;
        s_have_starboard = true;
    }
    xSemaphoreGive(s_store_mtx);
}

static esp_err_t radio_tx(const uint8_t *pkt, size_t len)
{
#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
    /* Freenove and similar: LoRa radio lives on the Meshtastic companion (UART PROTO). */
    return meshtastic_client_broadcast_bytes(pkt, len);
#else
    (void)pkt;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

static mark_role_t local_role(void)
{
    const device_type_t t = device_type_get();
    if (t == DEVICE_TYPE_PORT) {
        return MARK_ROLE_PORT;
    }
    if (t == DEVICE_TYPE_STARBOARD) {
        return MARK_ROLE_STARBOARD;
    }
    return (mark_role_t)0;
}

/** Format cm for JSON: 65535 means unknown → null. */
static void fmt_dist_json(char *buf, size_t buflen, uint16_t cm)
{
    if (cm == MARK_BROADCAST_DIST_UNKNOWN) {
        snprintf(buf, buflen, "null");
    } else {
        snprintf(buf, buflen, "%u", (unsigned)cm);
    }
}

/**
 * Boat → UI: opposite-mark distances from LoRa; boat↔mark from TDoA when solved.
 */
static void boat_geom_ble_notify(void)
{
    if (device_type_get() != DEVICE_TYPE_BOAT) {
        return;
    }
    if (s_store_mtx == NULL || xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        /* Avoid publishing a null wipe if we cannot read the store. */
        return;
    }

    uint16_t port_uwb = 0;
    uint16_t stb_uwb = 0;
    uint16_t port_to_stb = MARK_BROADCAST_DIST_UNKNOWN;
    uint16_t stb_to_port = MARK_BROADCAST_DIST_UNKNOWN;
    uint16_t boat_port = s_boat_to_port_cm;
    uint16_t boat_stb = s_boat_to_starboard_cm;
    uint16_t anchor_ps = MARK_BROADCAST_DIST_UNKNOWN;
    uint16_t anchor_pr = MARK_BROADCAST_DIST_UNKNOWN;
    uint16_t anchor_sr = MARK_BROADCAST_DIST_UNKNOWN;

    if (s_have_port) {
        port_uwb = s_port.uwb_addr;
        port_to_stb = s_port.dist_cm;
    }
    if (s_have_starboard) {
        stb_uwb = s_starboard.uwb_addr;
        stb_to_port = s_starboard.dist_cm;
    }
    xSemaphoreGive(s_store_mtx);

#if CONFIG_DW3000_RANGING_ENABLE
    mark_blink_get_geometry_cm(&anchor_ps, &anchor_pr, &anchor_sr, NULL);
#endif

    char bp[12], bs[12], ps[12], sp[12], aps[12], apr[12], asr[12];
    fmt_dist_json(bp, sizeof(bp), boat_port);
    fmt_dist_json(bs, sizeof(bs), boat_stb);
    fmt_dist_json(ps, sizeof(ps), port_to_stb);
    fmt_dist_json(sp, sizeof(sp), stb_to_port);
    fmt_dist_json(aps, sizeof(aps), anchor_ps);
    fmt_dist_json(apr, sizeof(apr), anchor_pr);
    fmt_dist_json(asr, sizeof(asr), anchor_sr);

    char line[320];
    const int n = snprintf(
        line, sizeof(line),
        "$PREGGEOM,{\"boat_port_cm\":%s,\"boat_starboard_cm\":%s,"
        "\"port_starboard_cm\":%s,\"starboard_port_cm\":%s,"
        "\"anchor_ps_cm\":%s,\"anchor_pr_cm\":%s,\"anchor_sr_cm\":%s,"
        "\"port_uwb\":%u,\"starboard_uwb\":%u}\n",
        bp, bs, ps, sp, aps, apr, asr, (unsigned)port_uwb, (unsigned)stb_uwb);
    if (n > 0 && (size_t)n < sizeof(line)) {
        ble_sen0140_meshtastic_rx_notify((const uint8_t *)line, (size_t)n);
    }
}

void mark_broadcast_publish_boat_tdoa(uint32_t seq, bool ok, double x_m, double y_m, double residual_m,
                                      double delta_sp_m, double delta_rp_m, uint16_t boat_port_cm,
                                      uint16_t boat_starboard_cm, uint16_t boat_reference_cm,
                                      double reference_x_m, double reference_y_m)
{
    if (device_type_get() != DEVICE_TYPE_BOAT) {
        return;
    }

    if (ok) {
        if (s_store_mtx != NULL && xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) == pdTRUE) {
            if (boat_port_cm != MARK_BROADCAST_DIST_UNKNOWN) {
                s_boat_to_port_cm = boat_port_cm;
            }
            if (boat_starboard_cm != MARK_BROADCAST_DIST_UNKNOWN) {
                s_boat_to_starboard_cm = boat_starboard_cm;
            }
            xSemaphoreGive(s_store_mtx);
        } else {
            if (boat_port_cm != MARK_BROADCAST_DIST_UNKNOWN) {
                s_boat_to_port_cm = boat_port_cm;
            }
            if (boat_starboard_cm != MARK_BROADCAST_DIST_UNKNOWN) {
                s_boat_to_starboard_cm = boat_starboard_cm;
            }
        }
        boat_geom_ble_notify();
    }

    char br[12];
    fmt_dist_json(br, sizeof(br), boat_reference_cm);

    char line[384];
    const int n = snprintf(
        line, sizeof(line),
        "$PREGTDOA,{\"seq\":%lu,\"ok\":%u,\"x_m\":%.3f,\"y_m\":%.3f,\"residual_m\":%.4f,"
        "\"delta_sp_m\":%.3f,\"delta_rp_m\":%.3f,\"reference_x_m\":%.3f,\"reference_y_m\":%.3f,"
        "\"boat_port_cm\":%u,\"boat_starboard_cm\":%u,\"boat_reference_cm\":%s}\n",
        (unsigned long)seq, ok ? 1U : 0U, x_m, y_m, residual_m, delta_sp_m, delta_rp_m,
        reference_x_m, reference_y_m,
        (unsigned)(boat_port_cm == MARK_BROADCAST_DIST_UNKNOWN ? 0U : boat_port_cm),
        (unsigned)(boat_starboard_cm == MARK_BROADCAST_DIST_UNKNOWN ? 0U : boat_starboard_cm), br);
    if (n > 0 && (size_t)n < sizeof(line)) {
        ble_sen0140_meshtastic_rx_notify((const uint8_t *)line, (size_t)n);
    }
}

static void mark_tx_once(void)
{
    const mark_role_t role = local_role();
    if (role != MARK_ROLE_PORT && role != MARK_ROLE_STARBOARD) {
        return;
    }

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
    if (!meshtastic_client_is_config_ready()) {
        /* Companion still handshaking — skip this cycle quietly. */
        return;
    }
#endif

    /* Baseline TWR lives in mark_blink quiet gaps — do not range here (would
     * collide with UWB beacons). Prefer blink geometry; fall back to last LoRa. */
    uint16_t dist = MARK_BROADCAST_DIST_UNKNOWN;
#if CONFIG_DW3000_RANGING_ENABLE
    uint16_t ps = ANCHOR_DIST_UNKNOWN;
    mark_blink_get_geometry_cm(&ps, NULL, NULL, NULL);
    if (ps != ANCHOR_DIST_UNKNOWN) {
        dist = ps;
        s_last_dist_cm = ps;
        s_last_dist_ok = true;
    } else if (s_last_dist_ok) {
        dist = s_last_dist_cm;
    }
#else
    if (s_last_dist_ok) {
        dist = s_last_dist_cm;
    }
#endif

    gps_fix_t fix = {0};
    const bool have_fix = gps_fix_get(&fix);

    uint8_t pkt[MARK_BROADCAST_PKT_LEN];
    encode_packet(role, self_uwb_addr(), have_fix ? &fix : NULL, dist, pkt);

    const char *role_name = role == MARK_ROLE_PORT ? "port" : "starboard";
    const char *opp_name = role == MARK_ROLE_PORT ? "starboard" : "port";

    const esp_err_t err = radio_tx(pkt, sizeof(pkt));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s broadcast FAILED: %s", role_name, esp_err_to_name(err));
        return;
    }
    if (have_fix) {
        ESP_LOGI(TAG,
                 "%s broadcast TX (%u B): role=%c uwb=0x%04X lat=%.6f lon=%.6f acc=%u cm dist→%s=%s%u cm",
                 role_name, (unsigned)MARK_BROADCAST_PKT_LEN, (char)role, self_uwb_addr(),
                 fix.lat_deg, fix.lon_deg, (unsigned)fix.accuracy_cm, opp_name,
                 dist == MARK_BROADCAST_DIST_UNKNOWN ? "?" : "",
                 dist == MARK_BROADCAST_DIST_UNKNOWN ? 0U : (unsigned)dist);
    } else {
        ESP_LOGI(TAG,
                 "%s broadcast TX (%u B): role=%c uwb=0x%04X gps=none dist→%s=%s%u cm",
                 role_name, (unsigned)MARK_BROADCAST_PKT_LEN, (char)role, self_uwb_addr(), opp_name,
                 dist == MARK_BROADCAST_DIST_UNKNOWN ? "?" : "",
                 dist == MARK_BROADCAST_DIST_UNKNOWN ? 0U : (unsigned)dist);
    }
}

static void mark_task(void *arg)
{
    (void)arg;
    const uint32_t mark_interval_ms = (uint32_t)CONFIG_MARK_BROADCAST_INTERVAL_MS;

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
    /* Wait for Meshtastic want_config before first TX (can take several seconds). */
    ESP_LOGI(TAG, "waiting for Meshtastic config…");
    while (!meshtastic_client_is_config_ready()) {
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    ESP_LOGI(TAG, "Meshtastic config ready — starting broadcasts");
#endif

    /* Stagger first TX slightly so peers don't collide after simultaneous boot. */
    vTaskDelay(pdMS_TO_TICKS(500 + (self_uwb_addr() & 0x3FFU)));

    for (;;) {
        const device_type_t t = device_type_get();
        if (t == DEVICE_TYPE_PORT || t == DEVICE_TYPE_STARBOARD) {
            mark_tx_once();
            vTaskDelay(pdMS_TO_TICKS(mark_interval_ms));
        } else {
            /* Boat: LoRa RX is callback-driven; UWB blink sniff is in mark_blink. */
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}

void mark_broadcast_on_rx(const uint8_t *data, size_t len, uint32_t from_node)
{
    mark_broadcast_record_t rec;
    if (!mark_broadcast_decode(data, len, &rec)) {
        return;
    }
    rec.received_us = (int64_t)esp_timer_get_time();
    rec.from_node = from_node;

    const device_type_t me = device_type_get();
    const mark_role_t my_role = local_role();

    /* Every opposing Port↔Starboard broadcast refreshes the peer UWB address used for ranging. */
    update_opposite_peer_uwb(my_role, rec.role, rec.uwb_addr);

    /* Boats store both sides; marks also keep a snapshot of the opposite side. */
    if (me == DEVICE_TYPE_BOAT || me == DEVICE_TYPE_PORT || me == DEVICE_TYPE_STARBOARD) {
        store_record(&rec);
        ESP_LOGI(TAG,
                 "%s RX broadcast: role=%c uwb=0x%04X lat=%.6f lon=%.6f acc=%u cm dist=%s%u cm from=0x%08lx",
                 device_type_to_string(me), (char)rec.role, rec.uwb_addr, rec.lat_e7 / 1e7, rec.lon_e7 / 1e7,
                 (unsigned)rec.accuracy_cm,
                 rec.dist_cm == MARK_BROADCAST_DIST_UNKNOWN ? "?" : "",
                 rec.dist_cm == MARK_BROADCAST_DIST_UNKNOWN ? 0U : (unsigned)rec.dist_cm,
                 (unsigned long)from_node);

        /* Structured notify for the web Meshtastic tab (field panels, not a log dump). */
        char line[192];
        const int n = snprintf(
            line, sizeof(line),
            "$PREGMARK,{\"role\":\"%c\",\"uwb\":%u,\"lat_e7\":%ld,\"lon_e7\":%ld,"
            "\"acc_cm\":%u,\"dist_cm\":%u,\"gps\":%s,\"from\":%lu}\n",
            (char)rec.role, (unsigned)rec.uwb_addr, (long)rec.lat_e7, (long)rec.lon_e7,
            (unsigned)rec.accuracy_cm,
            rec.dist_cm == MARK_BROADCAST_DIST_UNKNOWN ? 65535U : (unsigned)rec.dist_cm,
            rec.gps_valid ? "true" : "false", (unsigned long)from_node);
        if (n > 0 && (size_t)n < sizeof(line)) {
            ble_sen0140_meshtastic_rx_notify((const uint8_t *)line, (size_t)n);
        }
        if (me == DEVICE_TYPE_BOAT) {
            /* Push updated port↔starboard distances (and current boat ranges) to the UI. */
            boat_geom_ble_notify();
        }
    }
}

bool mark_broadcast_get_port(mark_broadcast_record_t *out)
{
    if (out == NULL || s_store_mtx == NULL) {
        return false;
    }
    if (xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
    const bool ok = s_have_port;
    if (ok) {
        *out = s_port;
    }
    xSemaphoreGive(s_store_mtx);
    return ok;
}

bool mark_broadcast_get_starboard(mark_broadcast_record_t *out)
{
    if (out == NULL || s_store_mtx == NULL) {
        return false;
    }
    if (xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
    const bool ok = s_have_starboard;
    if (ok) {
        *out = s_starboard;
    }
    xSemaphoreGive(s_store_mtx);
    return ok;
}

esp_err_t mark_broadcast_start(void)
{
    if (s_store_mtx == NULL) {
        s_store_mtx = xSemaphoreCreateMutex();
        if (s_store_mtx == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

#if CONFIG_MARK_BROADCAST_PEER_UWB_ADDR != 0
    s_peer_uwb = (uint16_t)CONFIG_MARK_BROADCAST_PEER_UWB_ADDR;
    s_peer_uwb_known = true;
#endif

    if (xTaskCreate(mark_task, "mark_bcast", 4096, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "task create failed");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "started (mark_interval=%d ms, peer_uwb=%s0x%04X)", CONFIG_MARK_BROADCAST_INTERVAL_MS,
             s_peer_uwb_known ? "" : "auto/", s_peer_uwb_known ? s_peer_uwb : 0U);
    return ESP_OK;
}

#else /* !CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE */

esp_err_t mark_broadcast_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void mark_broadcast_on_rx(const uint8_t *data, size_t len, uint32_t from_node)
{
    (void)data;
    (void)len;
    (void)from_node;
}

bool mark_broadcast_get_port(mark_broadcast_record_t *out)
{
    (void)out;
    return false;
}

bool mark_broadcast_get_starboard(mark_broadcast_record_t *out)
{
    (void)out;
    return false;
}

void mark_broadcast_publish_boat_tdoa(uint32_t seq, bool ok, double x_m, double y_m, double residual_m,
                                      double delta_sp_m, double delta_rp_m, uint16_t boat_port_cm,
                                      uint16_t boat_starboard_cm, uint16_t boat_reference_cm,
                                      double reference_x_m, double reference_y_m)
{
    (void)seq;
    (void)ok;
    (void)x_m;
    (void)y_m;
    (void)residual_m;
    (void)delta_sp_m;
    (void)delta_rp_m;
    (void)boat_port_cm;
    (void)boat_starboard_cm;
    (void)boat_reference_cm;
    (void)reference_x_m;
    (void)reference_y_m;
}

#endif /* CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE */
