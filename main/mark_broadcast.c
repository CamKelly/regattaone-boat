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

/** Boat-only: last successful UWB range to each mark (UNKNOWN until first success). */
static uint16_t s_boat_to_port_cm = MARK_BROADCAST_DIST_UNKNOWN;
static uint16_t s_boat_to_starboard_cm = MARK_BROADCAST_DIST_UNKNOWN;
static uint16_t s_boat_port_uwb;
static uint16_t s_boat_starboard_uwb;
/** Alternate which mark is ranged first so starboard is not always second. */
static bool s_boat_range_starboard_first;

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

static uint16_t peer_uwb_get(bool *known_out)
{
    peer_lock();
    const uint16_t peer = s_peer_uwb;
    const bool known = s_peer_uwb_known;
    peer_unlock();
    if (known_out != NULL) {
        *known_out = known;
    }
    return peer;
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

static void maybe_range_peer(void)
{
#if CONFIG_DW3000_RANGING_ENABLE
    bool known = false;
    uint16_t peer = peer_uwb_get(&known);
    if (!known) {
#if CONFIG_MARK_BROADCAST_PEER_UWB_ADDR != 0
        peer = (uint16_t)CONFIG_MARK_BROADCAST_PEER_UWB_ADDR;
        peer_lock();
        s_peer_uwb = peer;
        s_peer_uwb_known = true;
        peer_unlock();
        known = true;
#else
        /* Wait until the opposite mark's broadcast teaches us its UWB address. */
        return;
#endif
    }
    if (peer == 0U || peer == self_uwb_addr()) {
        return;
    }
    uint16_t cm = 0;
    const esp_err_t err = dw3000_range_to(peer, &cm, 500);
    if (err == ESP_OK) {
        s_last_dist_cm = cm;
        s_last_dist_ok = true;
        ESP_LOGI(TAG, "range to opposite 0x%04X = %u cm", peer, (unsigned)cm);
    } else {
        ESP_LOGD(TAG, "range to opposite 0x%04X failed: %s", peer, esp_err_to_name(err));
    }
#else
    (void)0;
#endif
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
 * Boat → UI: last-good boat↔port / boat↔starboard, plus opposite-mark distances
 * last heard on Meshtastic.
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

    if (s_have_port) {
        port_uwb = s_port.uwb_addr;
        port_to_stb = s_port.dist_cm;
    }
    if (s_have_starboard) {
        stb_uwb = s_starboard.uwb_addr;
        stb_to_port = s_starboard.dist_cm;
    }
    xSemaphoreGive(s_store_mtx);

    char bp[12], bs[12], ps[12], sp[12];
    fmt_dist_json(bp, sizeof(bp), boat_port);
    fmt_dist_json(bs, sizeof(bs), boat_stb);
    fmt_dist_json(ps, sizeof(ps), port_to_stb);
    fmt_dist_json(sp, sizeof(sp), stb_to_port);

    char line[256];
    const int n = snprintf(
        line, sizeof(line),
        "$PREGGEOM,{\"boat_port_cm\":%s,\"boat_starboard_cm\":%s,"
        "\"port_starboard_cm\":%s,\"starboard_port_cm\":%s,"
        "\"port_uwb\":%u,\"starboard_uwb\":%u}\n",
        bp, bs, ps, sp, (unsigned)port_uwb, (unsigned)stb_uwb);
    if (n > 0 && (size_t)n < sizeof(line)) {
        ble_sen0140_meshtastic_rx_notify((const uint8_t *)line, (size_t)n);
    }
}

#if CONFIG_DW3000_RANGING_ENABLE
/** Range once; on success writes *out_cm and returns true. Failures leave *out_cm untouched. */
static bool boat_range_one(uint16_t peer, const char *label, uint16_t *out_cm)
{
    if (peer == 0U) {
        ESP_LOGW(TAG, "boat → %s skipped: mark UWB address is 0", label);
        return false;
    }
    if (peer == self_uwb_addr()) {
        ESP_LOGW(TAG,
                 "boat → %s skipped: peer 0x%04X equals this device (give Port/Starboard/Boat unique UWB addresses)",
                 label, peer);
        return false;
    }
    uint16_t cm = 0;
    /* Long-preamble PHY needs more than the mark TX 500 ms budget. */
    const esp_err_t err = dw3000_range_to(peer, &cm, 1500U);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "boat → %s 0x%04X = %u cm", label, peer, (unsigned)cm);
        *out_cm = cm;
        return true;
    }
    ESP_LOGW(TAG, "boat → %s 0x%04X failed: %s", label, peer, esp_err_to_name(err));
    return false;
}

static void boat_range_once(void)
{
    uint16_t port_uwb = 0;
    uint16_t stb_uwb = 0;
    bool have_port = false;
    bool have_stb = false;

    if (s_store_mtx == NULL || xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
    have_port = s_have_port && s_port.uwb_addr != 0U;
    have_stb = s_have_starboard && s_starboard.uwb_addr != 0U;
    if (have_port) {
        port_uwb = s_port.uwb_addr;
        if (s_boat_port_uwb != port_uwb) {
            s_boat_port_uwb = port_uwb;
            s_boat_to_port_cm = MARK_BROADCAST_DIST_UNKNOWN;
        }
    }
    if (have_stb) {
        stb_uwb = s_starboard.uwb_addr;
        if (s_boat_starboard_uwb != stb_uwb) {
            s_boat_starboard_uwb = stb_uwb;
            s_boat_to_starboard_cm = MARK_BROADCAST_DIST_UNKNOWN;
        }
    }
    xSemaphoreGive(s_store_mtx);

    if (!have_port && !have_stb) {
        /* Wait until Meshtastic mark broadcasts teach us UWB addresses. */
        return;
    }

    /* Alternate first peer so a slow/failing port range does not starve starboard. */
    const bool stb_first = s_boat_range_starboard_first;
    s_boat_range_starboard_first = !s_boat_range_starboard_first;

    uint16_t to_port = MARK_BROADCAST_DIST_UNKNOWN;
    uint16_t to_stb = MARK_BROADCAST_DIST_UNKNOWN;
    bool got_port = false;
    bool got_stb = false;

    if (stb_first) {
        if (have_stb) {
            got_stb = boat_range_one(stb_uwb, "starboard", &to_stb);
        }
        if (have_port) {
            got_port = boat_range_one(port_uwb, "port", &to_port);
        }
    } else {
        if (have_port) {
            got_port = boat_range_one(port_uwb, "port", &to_port);
        }
        if (have_stb) {
            got_stb = boat_range_one(stb_uwb, "starboard", &to_stb);
        }
    }

    if (s_store_mtx != NULL && xSemaphoreTake(s_store_mtx, pdMS_TO_TICKS(50)) == pdTRUE) {
        /* Keep last good — transient UWB failures must not wipe a prior success. */
        if (got_port) {
            s_boat_to_port_cm = to_port;
        }
        if (got_stb) {
            s_boat_to_starboard_cm = to_stb;
        }
        xSemaphoreGive(s_store_mtx);
    }

    boat_geom_ble_notify();
}
#endif /* CONFIG_DW3000_RANGING_ENABLE */

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

    maybe_range_peer();

    gps_fix_t fix = {0};
    const bool have_fix = gps_fix_get(&fix);
    const uint16_t dist = s_last_dist_ok ? s_last_dist_cm : MARK_BROADCAST_DIST_UNKNOWN;

    uint8_t pkt[MARK_BROADCAST_PKT_LEN];
    encode_packet(role, self_uwb_addr(), have_fix ? &fix : NULL, dist, pkt);

    const esp_err_t err = radio_tx(pkt, sizeof(pkt));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "TX failed: %s", esp_err_to_name(err));
        return;
    }
    ESP_LOGI(TAG, "TX %c uwb=0x%04X gps=%d acc=%u cm dist=%s%u", (char)role, self_uwb_addr(),
             (int)have_fix, have_fix ? (unsigned)fix.accuracy_cm : 0U,
             dist == MARK_BROADCAST_DIST_UNKNOWN ? "?" : "",
             dist == MARK_BROADCAST_DIST_UNKNOWN ? 0U : (unsigned)dist);
}

static void mark_task(void *arg)
{
    (void)arg;
    const uint32_t mark_interval_ms = (uint32_t)CONFIG_MARK_BROADCAST_INTERVAL_MS;
#if CONFIG_DW3000_RANGING_ENABLE
    const uint32_t boat_interval_ms = (uint32_t)CONFIG_BOAT_RANGE_INTERVAL_MS;
#endif

#if CONFIG_REGATTAONE_MESHTASTIC_ENABLE
    /* Wait for Meshtastic want_config before first TX (can take several seconds). */
    ESP_LOGI(TAG, "waiting for Meshtastic config…");
    while (!meshtastic_client_is_config_ready()) {
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    ESP_LOGI(TAG, "Meshtastic config ready — starting broadcasts / boat ranging");
#endif

    /* Stagger first TX slightly so peers don't collide after simultaneous boot. */
    vTaskDelay(pdMS_TO_TICKS(500 + (self_uwb_addr() & 0x3FFU)));

    for (;;) {
        const device_type_t t = device_type_get();
        if (t == DEVICE_TYPE_PORT || t == DEVICE_TYPE_STARBOARD) {
            mark_tx_once();
            vTaskDelay(pdMS_TO_TICKS(mark_interval_ms));
        } else if (t == DEVICE_TYPE_BOAT) {
#if CONFIG_DW3000_RANGING_ENABLE
            boat_range_once();
            vTaskDelay(pdMS_TO_TICKS(boat_interval_ms));
#else
            vTaskDelay(pdMS_TO_TICKS(1000));
#endif
        } else {
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
        ESP_LOGI(TAG, "RX %c uwb=0x%04X lat=%.6f lon=%.6f acc=%u dist=%u from=0x%08lx",
                 (char)rec.role, rec.uwb_addr, rec.lat_e7 / 1e7, rec.lon_e7 / 1e7,
                 (unsigned)rec.accuracy_cm,
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
#if CONFIG_DW3000_RANGING_ENABLE
    ESP_LOGI(TAG, "started (mark_interval=%d ms, boat_range_interval=%d ms, peer_uwb=%s0x%04X)",
             CONFIG_MARK_BROADCAST_INTERVAL_MS, CONFIG_BOAT_RANGE_INTERVAL_MS,
             s_peer_uwb_known ? "" : "auto/", s_peer_uwb_known ? s_peer_uwb : 0U);
#else
    ESP_LOGI(TAG, "started (mark_interval=%d ms, peer_uwb=%s0x%04X)", CONFIG_MARK_BROADCAST_INTERVAL_MS,
             s_peer_uwb_known ? "" : "auto/", s_peer_uwb_known ? s_peer_uwb : 0U);
#endif
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

#endif /* CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE */
