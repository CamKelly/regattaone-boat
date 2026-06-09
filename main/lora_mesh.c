#include "lora_mesh.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_SX1262_ENABLE

#include "device_type.h"
#include "lora_stats.h"
#include "sx1262_lora.h"

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "lora_mesh";

#define LORA_MESH_LISTEN_US              (10LL * 1000000LL)
#define LORA_MESH_HEARTBEAT_US           (15LL * 1000000LL)
#define LORA_MESH_HEARTBEAT_JITTER_US    (2LL * 1000000LL)
#define LORA_MESH_RECLAIM_US             (60LL * 1000000LL)
#define LORA_MESH_COLLISION_BACKOFF_MIN_US (1LL * 1000000LL)
#define LORA_MESH_COLLISION_BACKOFF_MAX_US (5LL * 1000000LL)
#define LORA_MESH_ID_MIN                 1U
#define LORA_MESH_ID_MAX                 65535U
#define LORA_MESH_PICK_ATTEMPTS          128

typedef struct lora_mesh_peer {
    uint16_t id;
    uint8_t type;
    int64_t last_heard_us;
    struct lora_mesh_peer *next;
} lora_mesh_peer_t;

static bool s_active;
static lora_mesh_state_t s_state;
static uint16_t s_my_id;
static int64_t s_listen_start_us;
static int64_t s_listen_duration_us;
static int64_t s_next_heartbeat_us;
static uint32_t s_tx_ok;
static uint32_t s_tx_fail;
static uint32_t s_rx_count;
static uint32_t s_collision_yield;
static lora_mesh_peer_t *s_peers;
static bool s_task_started;

static int64_t mesh_now_us(void)
{
    return (int64_t)esp_timer_get_time();
}

static lora_mesh_peer_t *peer_find(uint16_t id)
{
    for (lora_mesh_peer_t *p = s_peers; p != NULL; p = p->next) {
        if (p->id == id) {
            return p;
        }
    }
    return NULL;
}

static void peer_remove(lora_mesh_peer_t *victim)
{
    lora_mesh_peer_t **pp = &s_peers;
    while (*pp != NULL) {
        if (*pp == victim) {
            *pp = victim->next;
            free(victim);
            return;
        }
        pp = &(*pp)->next;
    }
}

static void peer_upsert(uint16_t id, uint8_t type, int64_t now_us)
{
    lora_mesh_peer_t *p = peer_find(id);
    if (p == NULL) {
        p = (lora_mesh_peer_t *)calloc(1, sizeof(*p));
        if (p == NULL) {
            ESP_LOGW(TAG, "peer alloc failed id=%u", (unsigned)id);
            return;
        }
        p->id = id;
        p->next = s_peers;
        s_peers = p;
    }
    p->type = type;
    p->last_heard_us = now_us;
}

static void peer_prune_stale(int64_t now_us)
{
    lora_mesh_peer_t *p = s_peers;
    while (p != NULL) {
        lora_mesh_peer_t *next = p->next;
        if (now_us - p->last_heard_us > LORA_MESH_RECLAIM_US) {
            ESP_LOGI(TAG, "reclaim peer id=%u", (unsigned)p->id);
            peer_remove(p);
        }
        p = next;
    }
}

static void peers_clear(void)
{
    while (s_peers != NULL) {
        lora_mesh_peer_t *n = s_peers->next;
        free(s_peers);
        s_peers = n;
    }
}

static bool id_is_known(uint16_t id, int64_t now_us)
{
    if (id < LORA_MESH_ID_MIN) {
        return true;
    }
    const lora_mesh_peer_t *p = peer_find(id);
    if (p != NULL && now_us - p->last_heard_us <= LORA_MESH_RECLAIM_US) {
        return true;
    }
    if (s_state == LORA_MESH_STATE_LOCKED && s_my_id == id) {
        return true;
    }
    return false;
}

static uint16_t pick_random_id(int64_t now_us)
{
    for (int attempt = 0; attempt < LORA_MESH_PICK_ATTEMPTS; attempt++) {
        const uint32_t raw = (uint32_t)esp_random();
        const uint16_t id = (uint16_t)(LORA_MESH_ID_MIN + (raw % (LORA_MESH_ID_MAX - LORA_MESH_ID_MIN + 1U)));
        if (!id_is_known(id, now_us)) {
            return id;
        }
    }
    for (uint32_t id = LORA_MESH_ID_MIN; id <= LORA_MESH_ID_MAX; id++) {
        if (!id_is_known((uint16_t)id, now_us)) {
            return (uint16_t)id;
        }
    }
    return 0;
}

static void schedule_next_heartbeat(int64_t now_us)
{
    const int32_t jitter = (int32_t)(esp_random() % (uint32_t)(2LL * LORA_MESH_HEARTBEAT_JITTER_US + 1LL))
                           - (int32_t)LORA_MESH_HEARTBEAT_JITTER_US;
    s_next_heartbeat_us = now_us + LORA_MESH_HEARTBEAT_US + (int64_t)jitter;
}

static void lock_id(uint16_t id, int64_t now_us)
{
    s_my_id = id;
    s_state = LORA_MESH_STATE_LOCKED;
    schedule_next_heartbeat(now_us);
    ESP_LOGI(TAG, "locked mesh id=%u type=%u", (unsigned)id, (unsigned)device_type_get());
    lora_stats_request_notify();
}

static void begin_listening(int64_t now_us, int64_t duration_us)
{
    s_state = LORA_MESH_STATE_LISTENING;
    s_my_id = 0;
    s_listen_start_us = now_us;
    s_listen_duration_us = duration_us;
    s_next_heartbeat_us = 0;
    ESP_LOGI(TAG, "mesh listening (%lld ms)", (long long)(duration_us / 1000LL));
    lora_stats_request_notify();
}

static void try_claim_after_listen(int64_t now_us)
{
    peer_prune_stale(now_us);

    uint16_t id;
    if (s_peers == NULL) {
        id = LORA_MESH_ID_MIN;
    } else {
        id = pick_random_id(now_us);
    }

    if (id == 0) {
        ESP_LOGW(TAG, "no free mesh id — retry listen");
        begin_listening(now_us, LORA_MESH_LISTEN_US);
        return;
    }

    lock_id(id, now_us);
}

static void yield_and_repick(int64_t now_us)
{
    s_collision_yield++;
    ESP_LOGW(TAG, "collision on id=%u — backoff then repick", (unsigned)s_my_id);

    const uint32_t span = (uint32_t)(LORA_MESH_COLLISION_BACKOFF_MAX_US - LORA_MESH_COLLISION_BACKOFF_MIN_US);
    const int64_t backoff_us = LORA_MESH_COLLISION_BACKOFF_MIN_US + (int64_t)(esp_random() % (span + 1U));
    begin_listening(now_us, backoff_us);
}

static const char *state_name(lora_mesh_state_t st)
{
    switch (st) {
    case LORA_MESH_STATE_LISTENING:
        return "listening";
    case LORA_MESH_STATE_LOCKED:
        return "locked";
    default:
        return "off";
    }
}

void lora_mesh_init(void) {}

void lora_mesh_set_active(bool active)
{
    if (active == s_active) {
        return;
    }

    s_active = active;
    if (!active) {
        s_state = LORA_MESH_STATE_OFF;
        s_my_id = 0;
        s_listen_start_us = 0;
        s_next_heartbeat_us = 0;
        peers_clear();
        ESP_LOGI(TAG, "mesh off");
        lora_stats_request_notify();
        return;
    }

    lora_stats_set_stream_active(false);
    sx1262_lora_clear_tx_queue();
    begin_listening(mesh_now_us(), LORA_MESH_LISTEN_US);
    ESP_LOGI(TAG, "mesh on");
}

bool lora_mesh_active(void)
{
    return s_active;
}

lora_mesh_state_t lora_mesh_get_state(void)
{
    return s_active ? s_state : LORA_MESH_STATE_OFF;
}

static bool parse_packet(const uint8_t *data, size_t len, uint16_t *id_out, uint8_t *type_out)
{
    if (data == NULL || len < LORA_MESH_PKT_LEN || data[0] != LORA_MESH_MAGIC) {
        return false;
    }
    *id_out = (uint16_t)(((uint16_t)data[1] << 8) | data[2]);
    *type_out = data[3];
    return *id_out >= LORA_MESH_ID_MIN;
}

void lora_mesh_on_rx(const uint8_t *data, size_t len, int64_t now_us)
{
    if (!s_active) {
        return;
    }

    uint16_t id;
    uint8_t type;
    if (!parse_packet(data, len, &id, &type)) {
        return;
    }

    s_rx_count++;
    lora_stats_mesh_rx_heartbeat();

    if (s_state == LORA_MESH_STATE_LOCKED && id == s_my_id) {
        peer_upsert(id, type, now_us);
        yield_and_repick(now_us);
        return;
    }

    peer_upsert(id, type, now_us);
    lora_stats_request_notify();
}

void lora_mesh_build_heartbeat(uint8_t out[LORA_MESH_PKT_LEN])
{
    out[0] = LORA_MESH_MAGIC;
    out[1] = (uint8_t)(s_my_id >> 8);
    out[2] = (uint8_t)(s_my_id & 0xFF);
    out[3] = (uint8_t)device_type_get();
}

bool lora_mesh_heartbeat_due(int64_t now_us)
{
    return s_active && s_state == LORA_MESH_STATE_LOCKED && s_next_heartbeat_us > 0
           && now_us >= s_next_heartbeat_us;
}

void lora_mesh_tick(int64_t now_us)
{
    if (!s_active) {
        return;
    }

    peer_prune_stale(now_us);

    if (s_state == LORA_MESH_STATE_LISTENING) {
        if (now_us - s_listen_start_us >= s_listen_duration_us) {
            try_claim_after_listen(now_us);
        }
        return;
    }

    if (s_state == LORA_MESH_STATE_LOCKED && lora_mesh_heartbeat_due(now_us)) {
        uint8_t pkt[LORA_MESH_PKT_LEN];
        lora_mesh_build_heartbeat(pkt);
        const esp_err_t err = sx1262_lora_mesh_transmit(pkt, sizeof(pkt));
        if (err == ESP_OK) {
            s_tx_ok++;
            lora_stats_mesh_tx_ok();
        } else {
            s_tx_fail++;
            lora_stats_mesh_tx_fail();
        }
        schedule_next_heartbeat(now_us);
        lora_stats_request_notify();
    }
}

bool lora_mesh_append_json(char *out, size_t out_cap, size_t *pos)
{
    if (out == NULL || pos == NULL || *pos >= out_cap) {
        return false;
    }

    const int64_t now_us = mesh_now_us();
    const char *st = s_active ? state_name(s_state) : "off";
    const device_type_t my_type = device_type_get();

    int n;
    if (s_state == LORA_MESH_STATE_LOCKED) {
        n = snprintf(out + *pos, out_cap - *pos,
                     ",\"mesh\":{\"active\":%s,\"state\":\"%s\",\"my_id\":%u,\"my_type\":%u,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu,\"collision_yield\":%lu,\"peers\":[",
                     s_active ? "true" : "false", st, (unsigned)s_my_id, (unsigned)my_type,
                     (unsigned long)s_tx_ok, (unsigned long)s_tx_fail, (unsigned long)s_rx_count,
                     (unsigned long)s_collision_yield);
    } else {
        n = snprintf(out + *pos, out_cap - *pos,
                     ",\"mesh\":{\"active\":%s,\"state\":\"%s\",\"my_id\":null,\"my_type\":%u,"
                     "\"tx_ok\":%lu,\"tx_fail\":%lu,\"rx\":%lu,\"collision_yield\":%lu,\"peers\":[",
                     s_active ? "true" : "false", st, (unsigned)my_type, (unsigned long)s_tx_ok,
                     (unsigned long)s_tx_fail, (unsigned long)s_rx_count, (unsigned long)s_collision_yield);
    }
    if (n < 0 || (size_t)n >= out_cap - *pos) {
        return false;
    }
    *pos += (size_t)n;

    bool first = true;
    for (const lora_mesh_peer_t *p = s_peers; p != NULL; p = p->next) {
        const int64_t age_ms = (now_us - p->last_heard_us) / 1000LL;
        const int m = snprintf(out + *pos, out_cap - *pos, "%s{\"id\":%u,\"type\":%u,\"last_ms\":%lld}",
                               first ? "" : ",", (unsigned)p->id, (unsigned)p->type, (long long)age_ms);
        if (m < 0 || (size_t)m >= out_cap - *pos) {
            return false;
        }
        *pos += (size_t)m;
        first = false;
    }

    if (*pos + 2 >= out_cap) {
        return false;
    }
    out[(*pos)++] = ']';
    out[(*pos)++] = '}';
    return true;
}

static void lora_mesh_task(void *arg)
{
    (void)arg;
    for (;;) {
        if (s_active) {
            lora_mesh_tick(mesh_now_us());
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void lora_mesh_start_task(void)
{
    if (s_task_started) {
        return;
    }
    s_task_started = true;
    xTaskCreate(lora_mesh_task, "lora_mesh", 4096, NULL, 4, NULL);
}

#endif /* CONFIG_REGATTAONE_SX1262_ENABLE */
