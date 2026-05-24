#include "presence_sync.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "blues_notecard.h"
#include "boat_id.h"
#include "device_type.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_NOTECARD_ENABLE && CONFIG_REGATTAONE_PRESENCE_SYNC_ENABLE

static const char *TAG = "presence";

#define PRESENCE_INBOUND_FILE  "presence.qi"
#define PRESENCE_ACK_FILE      "presence_ack.qo"
#define PRESENCE_ACK_PORT      CONFIG_PRESENCE_ACK_PORT
#define PRESENCE_MESSAGE_ID_MAX 36U

typedef enum {
    PRESENCE_EVT_ONLINE,
    PRESENCE_EVT_OFFLINE,
    PRESENCE_EVT_ID_CHANGED,
    PRESENCE_EVT_REMOVED,
    PRESENCE_EVT_SNAPSHOT,
} presence_event_kind_t;

typedef struct {
    presence_event_kind_t kind;
    char mid[PRESENCE_MESSAGE_ID_MAX + 1U];
    int64_t ts;
    char id[BOAT_ID_MAX_LEN + 1U];
    char device_type[DEVICE_TYPE_STR_MAX + 1U];
    char old_id[BOAT_ID_MAX_LEN + 1U];
    char new_id[BOAT_ID_MAX_LEN + 1U];
} presence_event_t;

typedef struct {
    char device_id[BOAT_ID_MAX_LEN + 1U];
    char device_type[DEVICE_TYPE_STR_MAX + 1U];
    bool online;
    int64_t last_ts;
} presence_peer_t;

static presence_peer_t s_peers[CONFIG_PRESENCE_MAX_PEERS];
static size_t s_peer_count;
static bool s_ack_template_registered;
static bool s_hub_configured;

static bool response_has_err(const char *rsp)
{
    return rsp != NULL && strstr(rsp, "\"err\"") != NULL;
}

static bool response_err_is_empty_queue(const char *rsp)
{
    if (rsp == NULL) {
        return false;
    }
    return strstr(rsp, "note does not exist") != NULL || strstr(rsp, "file does not exist") != NULL ||
           strstr(rsp, "notefile not found") != NULL || strstr(rsp, "notefile-noexist") != NULL ||
           strstr(rsp, "no notes available") != NULL;
}

static esp_err_t nc_transact_buf(const char *req, size_t req_len, char **response_out)
{
    if (req_len == 0U || req[req_len - 1U] != '\n') {
        ESP_LOGW(TAG, "internal: request must end with newline");
        return ESP_ERR_INVALID_ARG;
    }
    return blues_notecard_transaction(req, req_len, response_out);
}

static const char *json_body_object(const char *json)
{
    const char *p = strstr(json, "\"body\":");
    if (p == NULL) {
        p = strstr(json, "\"body\" :");
    }
    if (p == NULL) {
        return NULL;
    }
    p = strchr(p, '{');
    return p;
}

static bool json_get_string(const char *json, const char *key, char *out, size_t out_cap)
{
    if (out_cap == 0U) {
        return false;
    }
    out[0] = '\0';

    char needle[48];
    int n = snprintf(needle, sizeof(needle), "\"%s\":\"", key);
    if (n <= 0 || (size_t)n >= sizeof(needle)) {
        return false;
    }

    const char *start = strstr(json, needle);
    if (start == NULL) {
        return false;
    }
    start += (size_t)n;

    size_t j = 0U;
    for (const char *p = start; *p != '\0' && *p != '"'; p++) {
        if (*p == '\\' && p[1] != '\0') {
            p++;
        }
        if (j + 1U >= out_cap) {
            return false;
        }
        out[j++] = *p;
    }
    out[j] = '\0';
    return j > 0U;
}

static bool json_get_int64(const char *json, const char *key, int64_t *out)
{
    char needle[32];
    int n = snprintf(needle, sizeof(needle), "\"%s\":", key);
    if (n <= 0 || (size_t)n >= sizeof(needle)) {
        return false;
    }

    const char *p = strstr(json, needle);
    if (p == NULL) {
        return false;
    }
    p += (size_t)n;
    while (*p == ' ') {
        p++;
    }

    char *end = NULL;
    long long v = strtoll(p, &end, 10);
    if (end == p) {
        return false;
    }
    *out = (int64_t)v;
    return true;
}

static int peer_index_by_id(const char *device_id)
{
    for (size_t i = 0U; i < s_peer_count; i++) {
        if (strcmp(s_peers[i].device_id, device_id) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static bool peer_upsert(const char *device_id, const char *device_type, bool online, int64_t ts)
{
    int idx = peer_index_by_id(device_id);
    if (idx < 0) {
        if (s_peer_count >= CONFIG_PRESENCE_MAX_PEERS) {
            ESP_LOGW(TAG, "peer table full, dropping %s", device_id);
            return false;
        }
        idx = (int)s_peer_count++;
        memset(&s_peers[idx], 0, sizeof(s_peers[idx]));
        strncpy(s_peers[idx].device_id, device_id, sizeof(s_peers[idx].device_id) - 1U);
    }

    presence_peer_t *peer = &s_peers[idx];
    peer->online = online;
    peer->last_ts = ts;
    if (device_type != NULL && device_type[0] != '\0') {
        strncpy(peer->device_type, device_type, sizeof(peer->device_type) - 1U);
    }
    return true;
}

static void peer_remove(const char *device_id)
{
    int idx = peer_index_by_id(device_id);
    if (idx < 0) {
        return;
    }

    for (size_t i = (size_t)idx; i + 1U < s_peer_count; i++) {
        s_peers[i] = s_peers[i + 1U];
    }
    s_peer_count--;
}

static void peer_rename(const char *old_id, const char *new_id, int64_t ts)
{
    int idx = peer_index_by_id(old_id);
    if (idx < 0) {
        (void)peer_upsert(new_id, "", true, ts);
        return;
    }

    strncpy(s_peers[idx].device_id, new_id, sizeof(s_peers[idx].device_id) - 1U);
    s_peers[idx].last_ts = ts;
}

static void peer_apply_snapshot(const char *body, int64_t ts)
{
    for (size_t i = 0U; i < s_peer_count; i++) {
        s_peers[i].online = false;
    }

    const char *d = strstr(body, "\"d\":");
    if (d == NULL) {
        return;
    }
    d = strchr(d, '[');
    if (d == NULL) {
        return;
    }

    const char *cursor = d + 1U;
    while ((cursor = strstr(cursor, "\"id\"")) != NULL) {
        char id[BOAT_ID_MAX_LEN + 1U];
        char dt[DEVICE_TYPE_STR_MAX + 1U];
        if (!json_get_string(cursor, "id", id, sizeof(id))) {
            cursor++;
            continue;
        }
        (void)json_get_string(cursor, "dt", dt, sizeof(dt));
        (void)peer_upsert(id, dt, true, ts);
        cursor++;
    }
}

static bool parse_presence_event(const char *body, presence_event_t *evt)
{
    memset(evt, 0, sizeof(*evt));

    char type_code[8];
    if (!json_get_string(body, "t", type_code, sizeof(type_code))) {
        return false;
    }
    if (!json_get_string(body, "mid", evt->mid, sizeof(evt->mid))) {
        (void)json_get_string(body, "id", evt->mid, sizeof(evt->mid));
    }
    if (evt->mid[0] == '\0') {
        return false;
    }
    (void)json_get_int64(body, "ts", &evt->ts);

    if (strcmp(type_code, "on") == 0) {
        evt->kind = PRESENCE_EVT_ONLINE;
        (void)json_get_string(body, "id", evt->id, sizeof(evt->id));
        (void)json_get_string(body, "dt", evt->device_type, sizeof(evt->device_type));
        return evt->id[0] != '\0';
    }
    if (strcmp(type_code, "off") == 0) {
        evt->kind = PRESENCE_EVT_OFFLINE;
        (void)json_get_string(body, "id", evt->id, sizeof(evt->id));
        return evt->id[0] != '\0';
    }
    if (strcmp(type_code, "rm") == 0) {
        evt->kind = PRESENCE_EVT_REMOVED;
        (void)json_get_string(body, "id", evt->id, sizeof(evt->id));
        return evt->id[0] != '\0';
    }
    if (strcmp(type_code, "id") == 0) {
        evt->kind = PRESENCE_EVT_ID_CHANGED;
        (void)json_get_string(body, "oid", evt->old_id, sizeof(evt->old_id));
        (void)json_get_string(body, "nid", evt->new_id, sizeof(evt->new_id));
        return evt->old_id[0] != '\0' && evt->new_id[0] != '\0';
    }
    if (strcmp(type_code, "snap") == 0) {
        evt->kind = PRESENCE_EVT_SNAPSHOT;
        return evt->mid[0] != '\0';
    }

    return false;
}

static bool apply_presence_event(const presence_event_t *evt)
{
    switch (evt->kind) {
    case PRESENCE_EVT_ONLINE:
        return peer_upsert(evt->id, evt->device_type, true, evt->ts);
    case PRESENCE_EVT_OFFLINE: {
        int idx = peer_index_by_id(evt->id);
        if (idx < 0) {
            return peer_upsert(evt->id, "", false, evt->ts);
        }
        s_peers[idx].online = false;
        s_peers[idx].last_ts = evt->ts;
        return true;
    }
    case PRESENCE_EVT_REMOVED:
        peer_remove(evt->id);
        return true;
    case PRESENCE_EVT_ID_CHANGED:
        peer_rename(evt->old_id, evt->new_id, evt->ts);
        return true;
    case PRESENCE_EVT_SNAPSHOT:
        return true;
    default:
        return false;
    }
}

static void log_presence_event(const presence_event_t *evt)
{
    switch (evt->kind) {
    case PRESENCE_EVT_ONLINE:
        ESP_LOGI(TAG, "DEVICE_ONLINE mid=%s id=%s dt=%s peers=%u", evt->mid, evt->id, evt->device_type,
                 (unsigned)s_peer_count);
        break;
    case PRESENCE_EVT_OFFLINE:
        ESP_LOGI(TAG, "DEVICE_OFFLINE mid=%s id=%s peers=%u", evt->mid, evt->id, (unsigned)s_peer_count);
        break;
    case PRESENCE_EVT_REMOVED:
        ESP_LOGI(TAG, "DEVICE_REMOVED mid=%s id=%s peers=%u", evt->mid, evt->id, (unsigned)s_peer_count);
        break;
    case PRESENCE_EVT_ID_CHANGED:
        ESP_LOGI(TAG, "DEVICE_ID_CHANGED mid=%s %s -> %s peers=%u", evt->mid, evt->old_id, evt->new_id,
                 (unsigned)s_peer_count);
        break;
    case PRESENCE_EVT_SNAPSHOT:
        ESP_LOGI(TAG, "ONLINE_DEVICE_SNAPSHOT mid=%s peer_count=%u", evt->mid, (unsigned)s_peer_count);
        for (size_t i = 0U; i < s_peer_count; i++) {
            ESP_LOGI(TAG, "  peer[%u] id=%s dt=%s online=%s", (unsigned)i, s_peers[i].device_id,
                     s_peers[i].device_type[0] != '\0' ? s_peers[i].device_type : "-",
                     s_peers[i].online ? "true" : "false");
        }
        break;
    default:
        break;
    }
}

static size_t json_escape(const char *in, char *out, size_t out_cap)
{
    size_t j = 0U;
    for (; *in != '\0' && j + 1U < out_cap; in++) {
        if (*in == '"' || *in == '\\') {
            if (j + 2U >= out_cap) {
                break;
            }
            out[j++] = '\\';
        }
        out[j++] = *in;
    }
    out[j] = '\0';
    return j;
}

static bool presence_ack_ensure_template(void)
{
    if (s_ack_template_registered) {
        return true;
    }

    char req[256];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"note.template\",\"file\":\"" PRESENCE_ACK_FILE "\",\"port\":%d,\"body\":{"
                     "\"mid\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\","
                     "\"ok\":true"
                     "}}\n",
                     PRESENCE_ACK_PORT);
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        return false;
    }

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(req, (size_t)n, &rsp);
    if (err != ESP_OK || response_has_err(rsp)) {
        ESP_LOGW(TAG, "presence_ack template failed: %s", rsp ? rsp : esp_err_to_name(err));
        free(rsp);
        return false;
    }

    free(rsp);
    s_ack_template_registered = true;
    ESP_LOGI(TAG, "registered template for " PRESENCE_ACK_FILE);
    return true;
}

static bool presence_send_ack(const char *mid, bool ok)
{
    if (!presence_ack_ensure_template()) {
        return false;
    }

    char mid_esc[PRESENCE_MESSAGE_ID_MAX * 2U + 1U];
    json_escape(mid, mid_esc, sizeof(mid_esc));

    char req[192];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"note.add\",\"file\":\"" PRESENCE_ACK_FILE
                     "\",\"body\":{\"mid\":\"%s\",\"ok\":%s}}\n",
                     mid_esc, ok ? "true" : "false");
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        return false;
    }

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(req, (size_t)n, &rsp);
    if (err != ESP_OK || response_has_err(rsp)) {
        ESP_LOGW(TAG, "presence_ack note.add failed mid=%s: %s", mid, rsp ? rsp : esp_err_to_name(err));
        free(rsp);
        return false;
    }

    free(rsp);
    ESP_LOGI(TAG, "presence_ack sent mid=%s ok=%s", mid, ok ? "true" : "false");
    return true;
}

static bool presence_hub_sync(void)
{
    char req[48];
    int n = snprintf(req, sizeof(req), "{\"req\":\"hub.sync\",\"sync\":true}\n");
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        return false;
    }

    char *rsp = NULL;
    esp_err_t err = nc_transact_buf(req, (size_t)n, &rsp);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "hub.sync failed (%s)", esp_err_to_name(err));
        free(rsp);
        return false;
    }
    if (response_has_err(rsp)) {
        ESP_LOGW(TAG, "hub.sync rejected: %s", rsp);
        free(rsp);
        return false;
    }
    ESP_LOGI(TAG, "hub.sync ok");
    free(rsp);
    return true;
}

static bool presence_hub_configure(void)
{
    if (s_hub_configured) {
        return true;
    }

    const char *product = CONFIG_NOTEHUB_PRODUCT_UID;
    if (product[0] == '\0') {
        return true;
    }

    char req[256];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"hub.set\",\"product\":\"%s\",\"mode\":\"periodic\",\"outbound\":360,\"inbound\":%d}\n",
                     product, CONFIG_PRESENCE_POLL_INTERVAL_SEC);
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        return false;
    }

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(req, (size_t)n, &rsp);
    if (err != ESP_OK || response_has_err(rsp)) {
        ESP_LOGW(TAG, "hub.set failed: %s", rsp ? rsp : esp_err_to_name(err));
        free(rsp);
        return false;
    }

    free(rsp);
    s_hub_configured = true;
    ESP_LOGI(TAG, "hub.set product=%s inbound=%ds", product, CONFIG_PRESENCE_POLL_INTERVAL_SEC);
    return true;
}

static void presence_drain_inbound(void)
{
    size_t drained = 0U;

    for (;;) {
        char req[96];
        int n = snprintf(req, sizeof(req), "{\"req\":\"note.get\",\"file\":\"" PRESENCE_INBOUND_FILE "\",\"delete\":true}\n");
        if (n <= 0 || (size_t)n >= sizeof(req)) {
            break;
        }

        char *rsp = NULL;
        esp_err_t err = nc_transact_buf(req, (size_t)n, &rsp);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "note.get failed (%s)", esp_err_to_name(err));
            free(rsp);
            break;
        }
        if (response_has_err(rsp)) {
            if (!response_err_is_empty_queue(rsp)) {
                ESP_LOGW(TAG, "note.get rejected: %s", rsp);
            } else if (drained == 0U) {
                ESP_LOGI(TAG, "presence.qi queue empty");
            }
            free(rsp);
            break;
        }

        drained++;

        const char *body = json_body_object(rsp);
        if (body == NULL) {
            ESP_LOGW(TAG, "note.get missing body: %s", rsp);
            free(rsp);
            break;
        }

        presence_event_t evt;
        if (!parse_presence_event(body, &evt)) {
            ESP_LOGW(TAG, "unparseable presence body: %s", body);
            char fallback_mid[PRESENCE_MESSAGE_ID_MAX + 1U];
            if (json_get_string(body, "mid", fallback_mid, sizeof(fallback_mid))) {
                (void)presence_send_ack(fallback_mid, false);
            }
            free(rsp);
            continue;
        }

        bool applied = apply_presence_event(&evt);
        if (evt.kind == PRESENCE_EVT_SNAPSHOT) {
            peer_apply_snapshot(body, evt.ts);
            applied = true;
        }

        if (applied) {
            log_presence_event(&evt);
            (void)presence_send_ack(evt.mid, true);
        } else {
            ESP_LOGW(TAG, "failed to apply mid=%s", evt.mid);
            (void)presence_send_ack(evt.mid, false);
        }

        free(rsp);
    }

    if (drained > 0U) {
        ESP_LOGI(TAG, "drained %u presence.qi note(s)", (unsigned)drained);
    }
}

static void presence_poll_task(void *arg)
{
    (void)arg;

    /* Let boat_note finish its first template + boot note before we hub.sync. */
    vTaskDelay(pdMS_TO_TICKS(3000));

    for (;;) {
        ESP_LOGI(TAG, "poll: sync + drain " PRESENCE_INBOUND_FILE);
        (void)presence_hub_configure();
        (void)presence_hub_sync();
        presence_drain_inbound();
        vTaskDelay(pdMS_TO_TICKS((TickType_t)CONFIG_PRESENCE_POLL_INTERVAL_SEC * 1000));
    }
}

void presence_sync_start(void)
{
    if (xTaskCreate(presence_poll_task, "presence", 6144, NULL, 3, NULL) != pdPASS) {
        ESP_LOGW(TAG, "presence task create failed");
    } else {
        ESP_LOGI(TAG, "presence sync started (poll=%ds)", CONFIG_PRESENCE_POLL_INTERVAL_SEC);
    }
}

size_t presence_peer_count(void)
{
    return s_peer_count;
}

bool presence_peer_get(size_t index, char *id_out, size_t id_cap, char *type_out, size_t type_cap, bool *online_out)
{
    if (index >= s_peer_count || id_out == NULL || id_cap == 0U) {
        return false;
    }

    strncpy(id_out, s_peers[index].device_id, id_cap - 1U);
    id_out[id_cap - 1U] = '\0';
    if (type_out != NULL && type_cap > 0U) {
        strncpy(type_out, s_peers[index].device_type, type_cap - 1U);
        type_out[type_cap - 1U] = '\0';
    }
    if (online_out != NULL) {
        *online_out = s_peers[index].online;
    }
    return true;
}

#else /* disabled */

void presence_sync_start(void)
{
}

size_t presence_peer_count(void)
{
    return 0U;
}

bool presence_peer_get(size_t index, char *id_out, size_t id_cap, char *type_out, size_t type_cap, bool *online_out)
{
    (void)index;
    (void)id_out;
    (void)id_cap;
    (void)type_out;
    (void)type_cap;
    (void)online_out;
    return false;
}

#endif
