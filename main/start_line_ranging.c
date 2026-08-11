#include "start_line_ranging.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "ble_sen0140.h"
#include "device_type.h"
#include "dw3000_config.h"
#include "dw3000_ranging.h"
#include "gps_fix.h"

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "dwmac.h"
#include "dwproto.h"
#include "mac802154.h"
#include "ranging.h"

#define SL_PROTOCOL_VERSION 1U
#define SL_MSG_REGISTER_REQUEST 0x40U
#define SL_MSG_REGISTER_RESPONSE 0x41U
#define SL_MSG_RANGING_GRANT 0x42U
#define SL_MAX_BOATS 16U
#define SL_FIRST_BOAT_ADDR 0x0100U
#define SL_POSITION_MARGIN_CM 30U
#define SL_TASK_STACK 6144U

typedef struct {
    uint8_t protocol_version;
    uint8_t reserved;
    uint16_t sequence;
    uint8_t uuid[16];
    int32_t latitude_e7;
    int32_t longitude_e7;
    uint16_t capabilities;
    uint8_t gps_valid;
    uint8_t reserved2;
    uint32_t nonce;
} __attribute__((packed)) register_request_t;

typedef struct {
    uint8_t protocol_version;
    uint8_t reserved;
    uint16_t sequence;
    uint8_t uuid[16];
    uint32_t request_nonce;
    uint16_t assigned_device_id;
    uint16_t port_device_id;
    uint16_t starboard_device_id;
    uint32_t port_starboard_distance_mm;
    uint32_t registration_lease_ms;
    uint32_t rotation_period_ms;
    uint32_t port_session_id;
    uint32_t configuration_version;
} __attribute__((packed)) register_response_t;

typedef struct {
    uint8_t protocol_version;
    uint8_t flags;
    uint16_t sequence;
    uint16_t target_boat_id;
    uint16_t port_device_id;
    uint16_t starboard_device_id;
    uint16_t reserved;
    uint32_t port_session_id;
    uint32_t configuration_version;
    uint32_t port_starboard_distance_mm;
    uint32_t baseline_age_ms;
    uint32_t slot_duration_us;
    uint32_t rotation_period_ms;
    uint32_t grant_nonce;
} __attribute__((packed)) ranging_grant_t;

typedef struct {
    bool active;
    uint8_t uuid[16];
    uint16_t addr;
    int32_t lat_e7;
    int32_t lon_e7;
    bool gps_valid;
    int64_t registered_ms;
    int64_t last_success_ms;
    uint32_t grants_sent;
    uint32_t missed;
    uint32_t completed;
} registered_boat_t;

typedef struct {
    bool registered;
    uint8_t uuid[16];
    uint16_t addr;
    uint32_t nonce;
    uint32_t session_id;
    uint32_t config_version;
    uint32_t rotation_ms;
    int64_t last_port_message_ms;
    uint16_t ps_cm;
    uint16_t bp_cm;
    uint16_t bs_cm;
    double x_m;
    double y_m;
    bool position_valid;
    bool position_stale;
    uint32_t position_seq;
    char failure[32];
} boat_state_t;

static const char *TAG = "start_line";
static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_grant_sem;
static SemaphoreHandle_t s_port_done_sem;
static registered_boat_t s_boats[SL_MAX_BOATS];
static boat_state_t s_boat;
static uint32_t s_session_id;
static uint32_t s_config_version = 1;
static uint32_t s_sequence;
static uint16_t s_ps_cm;
static int64_t s_baseline_ms;
static uint16_t s_active_boat;
static uint32_t s_active_nonce;
static uint32_t s_active_session;
static uint16_t s_active_sequence;
static int64_t s_grant_deadline_ms;
static uint16_t s_authorized_twr_peer;
static int64_t s_authorized_twr_deadline_ms;
static ranging_grant_t s_pending_grant;
static bool s_pending_grant_valid;
static size_t s_queue_cursor;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000LL; }

static void ui_notify(const uint8_t *data, size_t len)
{
    /* Console BLE exists independently of Meshtastic; FEE5 is retained as a
     * compatibility route for the existing structured-line parser. */
    ble_sen0140_console_line_notify(data, len);
    ble_sen0140_meshtastic_rx_notify(data, len);
}

static void lock(void)
{
    if (s_lock) (void)xSemaphoreTake(s_lock, portMAX_DELAY);
}

static void unlock(void)
{
    if (s_lock) xSemaphoreGive(s_lock);
}

static void uuid_format(const uint8_t uuid[16], char out[33])
{
    for (size_t i = 0; i < 16; i++) snprintf(out + i * 2U, 3U, "%02x", uuid[i]);
    out[32] = '\0';
}

static void derive_uuid(uint8_t uuid[16])
{
    uint8_t mac[6] = {0};
    (void)esp_efuse_mac_get_default(mac);
    static const uint8_t ns[10] = {'R','e','g','a','t','t','a','U','W','B'};
    memcpy(uuid, ns, sizeof(ns));
    memcpy(uuid + sizeof(ns), mac, sizeof(mac));
    /* RFC-4122-shaped, deterministic 128-bit hardware identity. */
    uuid[6] = (uint8_t)((uuid[6] & 0x0fU) | 0x50U);
    uuid[8] = (uint8_t)((uuid[8] & 0x3fU) | 0x80U);
}

static bool send_message(uint8_t func, const void *payload, size_t len, uint16_t dst)
{
    if (twr_in_progress()) return false;
    struct txbuf *tx = dwmac_txbuf_get();
    if (!tx) return false;
    void *out = dwprot_short_prepare(tx, len, func, dst);
    memcpy(out, payload, len);
    return dwmac_transmit(tx);
}

static size_t boat_count_locked(void)
{
    size_t n = 0;
    for (size_t i = 0; i < SL_MAX_BOATS; i++) if (s_boats[i].active) n++;
    return n;
}

static uint32_t rotation_ms_locked(void)
{
    const uint32_t count = (uint32_t)boat_count_locked();
    const uint32_t slot = dw3000_config_get()->grant_duration_ms;
    return count == 0U ? slot : count * slot;
}

static uint32_t effective_timeout_ms_locked(void)
{
    const uint32_t configured = dw3000_config_get()->inactivity_timeout_ms;
    const uint32_t queue_guard = rotation_ms_locked() * 3U;
    return configured > queue_guard ? configured : queue_guard;
}

static uint16_t allocate_addr_locked(void)
{
    for (uint32_t candidate = SL_FIRST_BOAT_ADDR; candidate < 0xffffU; candidate++) {
        bool used = false;
        for (size_t i = 0; i < SL_MAX_BOATS; i++) {
            if (s_boats[i].active && s_boats[i].addr == candidate) { used = true; break; }
        }
        if (!used) return (uint16_t)candidate;
    }
    return 0;
}

static void notify_status(void)
{
    char json[480];
    const size_t n = start_line_ranging_format_status(json, sizeof(json));
    if (n > 0U) ui_notify((const uint8_t *)json, n);
    if (device_type_get() == DEVICE_TYPE_PORT) {
        static const char begin[] = "$PREGBOATS,{\"reset\":1}\n";
        ui_notify((const uint8_t *)begin, sizeof(begin) - 1U);
        registered_boat_t boats[SL_MAX_BOATS];
        lock(); memcpy(boats, s_boats, sizeof(boats)); unlock();
        for (size_t i = 0; i < SL_MAX_BOATS; i++) if (boats[i].active) {
            char uuid[33]; uuid_format(boats[i].uuid, uuid);
            const int m = snprintf(json, sizeof(json),
                "$PREGBOATS,{\"id\":%u,\"uuid\":\"%s\",\"gps_valid\":%u,"
                "\"lat_e7\":%ld,\"lon_e7\":%ld,\"registered_age_ms\":%lld,"
                "\"last_range_age_ms\":%lld,\"grants\":%lu,\"missed\":%lu,\"completed\":%lu}\n",
                boats[i].addr, uuid, boats[i].gps_valid ? 1U : 0U, (long)boats[i].lat_e7,
                (long)boats[i].lon_e7, (long long)(now_ms() - boats[i].registered_ms),
                (long long)(now_ms() - boats[i].last_success_ms), (unsigned long)boats[i].grants_sent,
                (unsigned long)boats[i].missed, (unsigned long)boats[i].completed);
            if (m > 0 && (size_t)m < sizeof(json))
                ui_notify((const uint8_t *)json, (size_t)m);
        }
        static const char end[] = "$PREGBOATS,{\"end\":1}\n";
        ui_notify((const uint8_t *)end, sizeof(end) - 1U);
    }
}

static void port_register(const register_request_t *req)
{
    if (req->protocol_version != SL_PROTOCOL_VERSION) return;
    registered_boat_t *entry = NULL;
    lock();
    for (size_t i = 0; i < SL_MAX_BOATS; i++) {
        if (s_boats[i].active && memcmp(s_boats[i].uuid, req->uuid, 16) == 0) { entry = &s_boats[i]; break; }
    }
    if (!entry) {
        for (size_t i = 0; i < SL_MAX_BOATS; i++) if (!s_boats[i].active) { entry = &s_boats[i]; break; }
        if (entry) {
            memset(entry, 0, sizeof(*entry));
            entry->addr = allocate_addr_locked();
            if (entry->addr != 0U) {
                entry->active = true;
                memcpy(entry->uuid, req->uuid, 16);
                entry->registered_ms = now_ms();
                entry->last_success_ms = entry->registered_ms;
            }
        }
    }
    if (!entry || !entry->active) { unlock(); ESP_LOGW(TAG, "REGISTER rejected table full"); return; }
    entry->lat_e7 = req->latitude_e7;
    entry->lon_e7 = req->longitude_e7;
    entry->gps_valid = req->gps_valid != 0U;
    const uint16_t assigned = entry->addr;
    const uint32_t rotation = rotation_ms_locked();
    const uint32_t lease = effective_timeout_ms_locked();
    unlock();

    register_response_t rsp = {
        .protocol_version = SL_PROTOCOL_VERSION, .sequence = ++s_sequence,
        .request_nonce = req->nonce, .assigned_device_id = assigned,
        .port_device_id = START_LINE_PORT_ADDR, .starboard_device_id = START_LINE_STARBOARD_ADDR,
        .port_starboard_distance_mm = (uint32_t)s_ps_cm * 10U,
        .registration_lease_ms = lease, .rotation_period_ms = rotation,
        .port_session_id = s_session_id, .configuration_version = s_config_version,
    };
    memcpy(rsp.uuid, req->uuid, 16);
    (void)send_message(SL_MSG_REGISTER_RESPONSE, &rsp, sizeof(rsp), 0xffffU);
    char uuid[33]; uuid_format(req->uuid, uuid);
    ESP_LOGI(TAG, "REGISTER accepted uuid=%s boat=0x%04X nonce=%lu", uuid, assigned,
             (unsigned long)req->nonce);
    notify_status();
}

static void boat_accept_registration(const register_response_t *rsp)
{
    if (rsp->protocol_version != SL_PROTOCOL_VERSION || memcmp(rsp->uuid, s_boat.uuid, 16) != 0 ||
        rsp->request_nonce != s_boat.nonce || rsp->assigned_device_id < SL_FIRST_BOAT_ADDR) return;
    lock();
    s_boat.registered = true;
    s_boat.addr = rsp->assigned_device_id;
    s_boat.session_id = rsp->port_session_id;
    s_boat.config_version = rsp->configuration_version;
    s_boat.rotation_ms = rsp->rotation_period_ms;
    s_boat.last_port_message_ms = now_ms();
    s_boat.ps_cm = (uint16_t)(rsp->port_starboard_distance_mm / 10U);
    unlock();
    (void)dw3000_ranging_set_runtime_addr(rsp->assigned_device_id);
    ESP_LOGI(TAG, "STATE unregistered -> registered boat=0x%04X session=%lu", rsp->assigned_device_id,
             (unsigned long)rsp->port_session_id);
    notify_status();
}

static void accept_grant(const ranging_grant_t *grant)
{
    if (grant->protocol_version != SL_PROTOCOL_VERSION) return;
    if (device_type_get() == DEVICE_TYPE_STARBOARD) {
        lock();
        s_active_boat = grant->target_boat_id;
        s_active_nonce = grant->grant_nonce;
        s_active_session = grant->port_session_id;
        s_active_sequence = grant->sequence;
        s_grant_deadline_ms = now_ms() + (int64_t)(grant->slot_duration_us / 1000U);
        unlock();
        return;
    }
    if (device_type_get() != DEVICE_TYPE_BOAT) return;
    lock();
    const bool mine = s_boat.registered && grant->target_boat_id == s_boat.addr;
    if (mine && (grant->port_session_id != s_boat.session_id ||
                 grant->configuration_version != s_boat.config_version)) {
        s_boat.registered = false;
        s_boat.addr = 0;
        s_boat.nonce = esp_random();
        snprintf(s_boat.failure, sizeof(s_boat.failure), "Port configuration changed");
        unlock();
        (void)dw3000_ranging_set_runtime_addr(START_LINE_UNASSIGNED_ADDR);
        return;
    }
    if (mine) {
        s_pending_grant = *grant;
        s_pending_grant_valid = true;
        s_boat.last_port_message_ms = now_ms();
        s_boat.rotation_ms = grant->rotation_period_ms;
        s_boat.ps_cm = (uint16_t)(grant->port_starboard_distance_mm / 10U);
    }
    unlock();
    if (mine) {
        ESP_LOGI(TAG, "GRANT received seq=%u boat=0x%04X duration=%lu us ps=%u cm",
                 (unsigned)grant->sequence, (unsigned)grant->target_boat_id,
                 (unsigned long)grant->slot_duration_us, (unsigned)s_boat.ps_cm);
        xSemaphoreGive(s_grant_sem);
    }
}

bool start_line_ranging_try_handle(const struct rxbuf *rx)
{
    if (!rx || !dwprot_check_min_len(rx->buf, rx->len)) return false;
    const uint8_t func = dwprot_get_func(rx->buf);
    const void *payload = dwprot_get_payload(rx->buf);
    const size_t len = dwprot_get_payload_len(rx->buf, rx->len);
    if (func == SL_MSG_REGISTER_REQUEST) {
        const device_type_t role = device_type_get();
        ESP_LOGI(TAG, "RX REGISTER_REQUEST src=0x%04X len=%u (expect %u) role=%s",
                 (unsigned)dwprot_get_src(rx->buf), (unsigned)len,
                 (unsigned)sizeof(register_request_t), device_type_to_string(role));
        if (len == sizeof(register_request_t) && role == DEVICE_TYPE_PORT)
            port_register((const register_request_t *)payload);
        return true;
    }
    if (func == SL_MSG_REGISTER_RESPONSE) {
        if (len == sizeof(register_response_t) && device_type_get() == DEVICE_TYPE_BOAT)
            boat_accept_registration((const register_response_t *)payload);
        return true;
    }
    if (func == SL_MSG_RANGING_GRANT) {
        if (len == sizeof(ranging_grant_t)) accept_grant((const ranging_grant_t *)payload);
        return true;
    }
    return false;
}

bool start_line_ranging_allow_twr(const struct rxbuf *rx)
{
    if (!rx || !dwprot_check_min_len(rx->buf, rx->len)) return false;
    const uint16_t src = (uint16_t)dwprot_get_src(rx->buf);
    const uint8_t func = dwprot_get_func(rx->buf);
    struct twr_context context;
    if (!twr_get_message_context(rx, &context)) return false;
    /* Responder-side libdeca does not mark twr_in_progress, so retain the
     * admitted Poll peer through its Final/Report sequence. */
    if (func != 0x21U) {
        lock();
        const bool responder_sequence = src == s_authorized_twr_peer && now_ms() <= s_authorized_twr_deadline_ms;
        unlock();
        return twr_in_progress() || responder_sequence;
    }
    const device_type_t role = device_type_get();
    if (role == DEVICE_TYPE_STARBOARD && src == START_LINE_PORT_ADDR) {
        lock(); s_authorized_twr_peer = src; s_authorized_twr_deadline_ms = now_ms() + 250; unlock();
        return true;
    }
    lock();
    const bool active = src == s_active_boat && now_ms() <= s_grant_deadline_ms &&
                        context.protocol_version == SL_PROTOCOL_VERSION &&
                        context.session_id == s_active_session &&
                        context.grant_nonce == s_active_nonce &&
                        context.grant_sequence == s_active_sequence;
    if (active) { s_authorized_twr_peer = src; s_authorized_twr_deadline_ms = s_grant_deadline_ms; }
    unlock();
    return (role == DEVICE_TYPE_PORT || role == DEVICE_TYPE_STARBOARD) && active;
}

void start_line_ranging_on_twr_result(uint64_t src64, uint64_t dst64, uint16_t dist, uint16_t num)
{
    const uint16_t src = (uint16_t)src64;
    const uint16_t dst = (uint16_t)dst64;
    const bool ok = dist != TWR_FAILED_VALUE && dist != TWR_OK_VALUE;
    if (device_type_get() == DEVICE_TYPE_STARBOARD && src == START_LINE_PORT_ADDR &&
        dst == START_LINE_STARBOARD_ADDR && ok) {
        lock(); s_ps_cm = dist; s_baseline_ms = now_ms(); unlock();
        ESP_LOGI(TAG, "BASELINE received ps=%u cm", (unsigned)dist);
        notify_status();
    }
    if (device_type_get() == DEVICE_TYPE_PORT && dst == START_LINE_PORT_ADDR) {
        lock();
        if (ok && src == s_active_boat && now_ms() <= s_grant_deadline_ms) {
            for (size_t i = 0; i < SL_MAX_BOATS; i++) if (s_boats[i].active && s_boats[i].addr == src) {
                s_boats[i].last_success_ms = now_ms(); s_boats[i].missed = 0; s_boats[i].completed++; break;
            }
            unlock();
            ESP_LOGI(TAG, "GRANT completed boat=0x%04X twr=%u", src, (unsigned)num);
            xSemaphoreGive(s_port_done_sem);
            return;
        }
        unlock();
    }
}

static bool valid_triangle(uint16_t ps, uint16_t bp, uint16_t bs)
{
    return (uint32_t)bp + bs + SL_POSITION_MARGIN_CM >= ps &&
           (uint32_t)bp + ps + SL_POSITION_MARGIN_CM >= bs &&
           (uint32_t)bs + ps + SL_POSITION_MARGIN_CM >= bp;
}

static void publish_boat_position(uint16_t seq, bool fresh)
{
    char line[320];
    lock();
    const int n = snprintf(line, sizeof(line),
        "$PREGSTART,{\"role\":\"boat\",\"registered\":%u,\"boat_id\":%u,"
        "\"session\":%lu,\"seq\":%u,\"fresh\":%u,\"ps_cm\":%u,\"bp_cm\":%u,"
        "\"bs_cm\":%u,\"x_m\":%.3f,\"y_m\":%.3f,\"failure\":\"%s\"}\n",
        s_boat.registered ? 1U : 0U, (unsigned)s_boat.addr, (unsigned long)s_boat.session_id,
        (unsigned)seq, fresh ? 1U : 0U, (unsigned)s_boat.ps_cm, (unsigned)s_boat.bp_cm,
        (unsigned)s_boat.bs_cm, s_boat.x_m, s_boat.y_m, s_boat.failure);
    unlock();
    if (n > 0 && (size_t)n < sizeof(line)) ui_notify((const uint8_t *)line, (size_t)n);
}

static void boat_run_grant(const ranging_grant_t *grant)
{
    const int64_t deadline = now_ms() + (int64_t)(grant->slot_duration_us / 1000U);
    uint16_t bs = 0, bp = 0;
    twr_set_context(grant->port_session_id, grant->grant_nonce, grant->sequence,
                    SL_PROTOCOL_VERSION);
    twr_set_max_attempts((uint8_t)(dw3000_config_get()->boat_range_retries + 1U));
    esp_err_t es = ESP_ERR_TIMEOUT, ep = ESP_ERR_TIMEOUT;
    if (now_ms() < deadline)
        es = dw3000_range_to(START_LINE_STARBOARD_ADDR, &bs, (uint32_t)(deadline - now_ms()));
    if (es == ESP_OK) ESP_LOGI(TAG, "TWR starboard seq=%u success distance=%u cm",
                               (unsigned)grant->sequence, (unsigned)bs);
    else ESP_LOGW(TAG, "TWR starboard seq=%u failure=%s", (unsigned)grant->sequence,
                  esp_err_to_name(es));
    if (es == ESP_OK && now_ms() < deadline) {
        ep = dw3000_range_to(START_LINE_PORT_ADDR, &bp, (uint32_t)(deadline - now_ms()));
    }
    if (ep == ESP_OK) ESP_LOGI(TAG, "TWR port seq=%u success distance=%u cm",
                               (unsigned)grant->sequence, (unsigned)bp);
    else ESP_LOGW(TAG, "TWR port seq=%u failure=%s", (unsigned)grant->sequence,
                  esp_err_to_name(ep));
    lock();
    const uint16_t ps = s_boat.ps_cm;
    const bool good = es == ESP_OK && ep == ESP_OK && ps > 0U && valid_triangle(ps, bp, bs);
    if (good) {
        const double l = ps / 100.0, rp = bp / 100.0, rs = bs / 100.0;
        s_boat.x_m = (rp * rp - rs * rs + l * l) / (2.0 * l);
        s_boat.y_m = sqrt(fmax(0.0, rp * rp - s_boat.x_m * s_boat.x_m));
        s_boat.bp_cm = bp; s_boat.bs_cm = bs; s_boat.position_valid = true;
        s_boat.position_stale = false; s_boat.position_seq = grant->sequence; s_boat.failure[0] = '\0';
    } else {
        s_boat.position_stale = s_boat.position_valid;
        snprintf(s_boat.failure, sizeof(s_boat.failure), "%s",
                 es != ESP_OK ? "Starboard TWR failed" : ep != ESP_OK ? "Port TWR failed" : "Invalid triangle");
    }
    unlock();
    if (good) ESP_LOGI(TAG, "POSITION valid seq=%u ps=%u bp=%u bs=%u x=%.3f y=%.3f",
                       (unsigned)grant->sequence, ps, bp, bs, s_boat.x_m, s_boat.y_m);
    else ESP_LOGW(TAG, "POSITION stale seq=%u reason=%s", (unsigned)grant->sequence, s_boat.failure);
    publish_boat_position(grant->sequence, good);
}

static void boat_task(void *arg)
{
    (void)arg;
    int64_t next_registration = 0;
    for (;;) {
        lock();
        bool registered = s_boat.registered;
        const int64_t last_port = s_boat.last_port_message_ms;
        const uint32_t rotation = s_boat.rotation_ms;
        unlock();
        const uint32_t configured = dw3000_config_get()->inactivity_timeout_ms;
        const uint32_t guard = rotation * 3U;
        const uint32_t timeout = configured > guard ? configured : guard;
        if (registered && last_port > 0 && now_ms() - last_port > timeout) {
            lock(); s_boat.registered = false; s_boat.addr = 0; s_boat.nonce = esp_random();
            s_boat.position_stale = s_boat.position_valid;
            snprintf(s_boat.failure, sizeof(s_boat.failure), "Port timeout"); unlock();
            (void)dw3000_ranging_set_runtime_addr(START_LINE_UNASSIGNED_ADDR);
            ESP_LOGW(TAG, "STATE registered -> unregistered reason=Port timeout");
            registered = false; next_registration = 0; notify_status();
        }
        if (!registered && now_ms() >= next_registration) {
            register_request_t req = {.protocol_version = SL_PROTOCOL_VERSION, .sequence = ++s_sequence,
                                      .capabilities = 1U, .nonce = s_boat.nonce};
            memcpy(req.uuid, s_boat.uuid, 16);
            gps_fix_t fix;
            if (gps_fix_get(&fix)) {
                req.gps_valid = 1U; req.latitude_e7 = (int32_t)llround(fix.lat_deg * 1e7);
                req.longitude_e7 = (int32_t)llround(fix.lon_deg * 1e7);
            }
            const bool sent = send_message(SL_MSG_REGISTER_REQUEST, &req, sizeof(req), 0xffffU);
            char uuid[33]; uuid_format(req.uuid, uuid);
            if (sent) {
                ESP_LOGI(TAG, "TX registration blink REGISTER_REQUEST seq=%u src=0x0000 dst=0xFFFF "
                         "uuid=%s nonce=%lu",
                         (unsigned)req.sequence, uuid, (unsigned long)req.nonce);
            } else {
                ESP_LOGW(TAG, "TX registration blink FAILED seq=%u uuid=%s nonce=%lu twr_busy=%u",
                         (unsigned)req.sequence, uuid, (unsigned long)req.nonce,
                         twr_in_progress() ? 1U : 0U);
            }
            const int32_t jitter = (int32_t)(esp_random() % 1001U) - 500;
            next_registration = now_ms() + (int64_t)dw3000_config_get()->registration_interval_ms + jitter;
        }
        if (xSemaphoreTake(s_grant_sem, pdMS_TO_TICKS(20)) == pdTRUE) {
            lock(); const bool have = s_pending_grant_valid; ranging_grant_t grant = s_pending_grant;
            s_pending_grant_valid = false; unlock();
            if (have) boat_run_grant(&grant);
        }
    }
}

static bool port_measure_baseline(void)
{
    uint16_t cm = 0;
    twr_set_context(s_session_id, 0U, (uint16_t)++s_sequence, SL_PROTOCOL_VERSION);
    twr_set_max_attempts(1U);
    for (uint8_t attempt = 0; attempt < dw3000_config_get()->baseline_retries; attempt++) {
        if (dw3000_range_to(START_LINE_STARBOARD_ADDR, &cm, 200U) == ESP_OK) {
            lock(); s_ps_cm = cm; s_baseline_ms = now_ms(); unlock();
            ESP_LOGI(TAG, "BASELINE success ps=%u cm", (unsigned)cm);
            notify_status(); return true;
        }
    }
    ESP_LOGW(TAG, "BASELINE failed after %u attempts", (unsigned)dw3000_config_get()->baseline_retries);
    return s_ps_cm > 0U && now_ms() - s_baseline_ms <= dw3000_config_get()->baseline_max_age_ms;
}

static void expire_boats(void)
{
    lock();
    const int64_t now = now_ms();
    const uint32_t timeout = effective_timeout_ms_locked();
    for (size_t i = 0; i < SL_MAX_BOATS; i++) if (s_boats[i].active &&
        ((uint64_t)(now - s_boats[i].last_success_ms) > timeout ||
         s_boats[i].missed >= dw3000_config_get()->max_missed_grants)) {
        ESP_LOGW(TAG, "REMOVE boat=0x%04X reason=%s", s_boats[i].addr,
                 s_boats[i].missed >= dw3000_config_get()->max_missed_grants ? "missed grants" : "timeout");
        memset(&s_boats[i], 0, sizeof(s_boats[i]));
    }
    unlock();
}

static void port_task(void *arg)
{
    (void)arg;
    for (;;) {
        expire_boats();
        if (dw3000_config_get()->scheduler_paused) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        lock(); const size_t count = boat_count_locked(); unlock();
        if (count == 0U) { vTaskDelay(pdMS_TO_TICKS(50)); continue; }
        if (!port_measure_baseline()) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        for (size_t visited = 0; visited < count; visited++) {
            lock();
            registered_boat_t *boat = NULL;
            for (size_t scan = 0; scan < SL_MAX_BOATS; scan++) {
                const size_t idx = (s_queue_cursor + scan) % SL_MAX_BOATS;
                if (s_boats[idx].active) { boat = &s_boats[idx]; s_queue_cursor = (idx + 1U) % SL_MAX_BOATS; break; }
            }
            if (!boat) { unlock(); break; }
            const uint16_t addr = boat->addr;
            boat->grants_sent++;
            const uint32_t rotation = rotation_ms_locked();
            const uint32_t nonce = esp_random();
            s_active_boat = addr; s_active_nonce = nonce;
            s_active_session = s_session_id;
            s_grant_deadline_ms = now_ms() + dw3000_config_get()->grant_duration_ms;
            unlock();
            ranging_grant_t grant = {
                .protocol_version = SL_PROTOCOL_VERSION, .sequence = (uint16_t)++s_sequence,
                .target_boat_id = addr, .port_device_id = START_LINE_PORT_ADDR,
                .starboard_device_id = START_LINE_STARBOARD_ADDR, .port_session_id = s_session_id,
                .configuration_version = s_config_version, .port_starboard_distance_mm = (uint32_t)s_ps_cm * 10U,
                .baseline_age_ms = (uint32_t)(now_ms() - s_baseline_ms),
                .slot_duration_us = dw3000_config_get()->grant_duration_ms * 1000U,
                .rotation_period_ms = rotation, .grant_nonce = nonce,
            };
            lock(); s_active_sequence = grant.sequence; unlock();
            xSemaphoreTake(s_port_done_sem, 0);
            if (!send_message(SL_MSG_RANGING_GRANT, &grant, sizeof(grant), 0xffffU)) {
                ESP_LOGW(TAG, "GRANT send failed boat=0x%04X", addr);
            } else {
                ESP_LOGI(TAG, "GRANT sent seq=%u boat=0x%04X duration=%lu us", grant.sequence, addr,
                         (unsigned long)grant.slot_duration_us);
            }
            const bool done = xSemaphoreTake(s_port_done_sem, pdMS_TO_TICKS(dw3000_config_get()->grant_duration_ms)) == pdTRUE;
            if (!done) {
                lock(); for (size_t i = 0; i < SL_MAX_BOATS; i++) if (s_boats[i].active && s_boats[i].addr == addr) {
                    s_boats[i].missed++; break;
                } unlock();
                ESP_LOGW(TAG, "GRANT expired boat=0x%04X", addr);
            }
            lock(); s_active_boat = 0; s_grant_deadline_ms = 0; unlock();
            expire_boats();
        }
        notify_status();
    }
}

size_t start_line_ranging_format_status(char *out, size_t cap)
{
    if (!out || cap == 0U) return 0U;
    lock();
    const device_type_t role = device_type_get();
    int n;
    if (role == DEVICE_TYPE_BOAT) {
        char uuid[33]; uuid_format(s_boat.uuid, uuid);
        n = snprintf(out, cap,
            "$PREGUWB,{\"role\":\"boat\",\"uuid\":\"%s\",\"registered\":%u,"
            "\"boat_id\":%u,\"session\":%lu,\"ps_cm\":%u,\"bp_cm\":%u,\"bs_cm\":%u,"
            "\"position_valid\":%u,\"stale\":%u,\"x_m\":%.3f,\"y_m\":%.3f,\"failure\":\"%s\"}\n",
            uuid, s_boat.registered ? 1U : 0U, s_boat.addr, (unsigned long)s_boat.session_id,
            s_boat.ps_cm, s_boat.bp_cm, s_boat.bs_cm, s_boat.position_valid ? 1U : 0U,
            s_boat.position_stale ? 1U : 0U, s_boat.x_m, s_boat.y_m, s_boat.failure);
    } else {
        n = snprintf(out, cap,
            "$PREGUWB,{\"role\":\"%s\",\"session\":%lu,\"ps_cm\":%u,"
            "\"baseline_age_ms\":%lld,\"registered_count\":%u,\"active_boat\":%u,"
            "\"rotation_ms\":%lu,\"paused\":%u}\n",
            role == DEVICE_TYPE_PORT ? "port" : "starboard", (unsigned long)s_session_id, s_ps_cm,
            s_baseline_ms ? (long long)(now_ms() - s_baseline_ms) : -1LL,
            (unsigned)boat_count_locked(), s_active_boat, (unsigned long)rotation_ms_locked(),
            dw3000_config_get()->scheduler_paused ? 1U : 0U);
    }
    unlock();
    return n > 0 && (size_t)n < cap ? (size_t)n : 0U;
}

uint16_t start_line_ranging_baseline_cm(void)
{
    lock(); const uint16_t cm = s_ps_cm; unlock();
    return cm == 0U ? UINT16_MAX : cm;
}

void start_line_ranging_config_changed(void)
{
    lock(); s_config_version++; unlock();
}

esp_err_t start_line_ranging_start(void)
{
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    if (!s_grant_sem) s_grant_sem = xSemaphoreCreateBinary();
    if (!s_port_done_sem) s_port_done_sem = xSemaphoreCreateBinary();
    if (!s_lock || !s_grant_sem || !s_port_done_sem) return ESP_ERR_NO_MEM;
    s_session_id = esp_random();
    const device_type_t role = device_type_get();
    uint16_t addr = role == DEVICE_TYPE_PORT ? START_LINE_PORT_ADDR :
                    role == DEVICE_TYPE_STARBOARD ? START_LINE_STARBOARD_ADDR : START_LINE_UNASSIGNED_ADDR;
    ESP_ERROR_CHECK_WITHOUT_ABORT(dw3000_ranging_set_runtime_addr(addr));
    if (role == DEVICE_TYPE_BOAT) {
        derive_uuid(s_boat.uuid); s_boat.nonce = esp_random();
        if (xTaskCreate(boat_task, "uwb_boat", SL_TASK_STACK, NULL, 5, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    } else if (role == DEVICE_TYPE_PORT) {
        if (xTaskCreate(port_task, "uwb_port", SL_TASK_STACK, NULL, 5, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "started role=%s addr=0x%04X session=%lu", device_type_to_string(role), addr,
             (unsigned long)s_session_id);
    return ESP_OK;
}
