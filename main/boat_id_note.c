#include "boat_id_note.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "boat_id.h"
#include "blues_notecard.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "boat_id_note";

#define BOAT_ID_NOTE_FILE "boat_id.qo"
/** Unique outbound queue port (1–100) for this notefile on the Notecard. */
#define BOAT_ID_NOTE_PORT   11

typedef struct {
    boat_id_note_reason_t reason;
    char id[BOAT_ID_MAX_LEN + 1U];
} boat_id_note_args_t;

static bool s_template_registered;

static const char *reason_string(boat_id_note_reason_t reason)
{
    switch (reason) {
    case BOAT_ID_NOTE_BOOT:
        return "boot";
    case BOAT_ID_NOTE_SET:
        return "set";
    case BOAT_ID_NOTE_CHANGED:
        return "changed";
    default:
        return "unknown";
    }
}

static bool response_has_err(const char *rsp)
{
    return rsp != NULL && strstr(rsp, "\"err\"") != NULL;
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

static bool boat_id_note_ensure_template(void)
{
    if (s_template_registered) {
        return true;
    }

    char req[256];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"note.template\",\"file\":\"" BOAT_ID_NOTE_FILE "\",\"port\":%d,\"body\":{"
                     "\"id\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\","
                     "\"reason\":\"xxxxxxx\""
                     "}}\n",
                     BOAT_ID_NOTE_PORT);
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        ESP_LOGW(TAG, "note.template request too long");
        return false;
    }

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(req, (size_t)n, &rsp);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "note.template failed (%s)", esp_err_to_name(err));
        free(rsp);
        return false;
    }
    if (response_has_err(rsp)) {
        ESP_LOGW(TAG, "note.template response: %s", rsp);
        free(rsp);
        return false;
    }

    free(rsp);
    s_template_registered = true;
    ESP_LOGI(TAG, "registered template for " BOAT_ID_NOTE_FILE);
    return true;
}

static void boat_id_note_task(void *arg)
{
    boat_id_note_args_t *args = (boat_id_note_args_t *)arg;
    const char *reason = reason_string(args->reason);

    char id_esc[BOAT_ID_MAX_LEN * 2U + 1U];
    json_escape(args->id, id_esc, sizeof(id_esc));
    free(args);

    if (!boat_id_note_ensure_template()) {
        ESP_LOGW(TAG, "skipped note.add reason=%s id=%s (no template)", reason, id_esc);
        vTaskDelete(NULL);
        return;
    }

    char req[192];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"note.add\",\"file\":\"" BOAT_ID_NOTE_FILE
                     "\",\"body\":{\"id\":\"%s\",\"reason\":\"%s\"}}\n",
                     id_esc, reason);
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        ESP_LOGW(TAG, "note request too long");
        vTaskDelete(NULL);
        return;
    }

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(req, (size_t)n, &rsp);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "note.add failed (%s) reason=%s id=%s", esp_err_to_name(err), reason, id_esc);
    } else if (response_has_err(rsp)) {
        ESP_LOGW(TAG, "note.add rejected: %s", rsp);
    } else {
        ESP_LOGI(TAG, "note.add ok reason=%s id=%s", reason, id_esc);
    }
    free(rsp);
    vTaskDelete(NULL);
}

void boat_id_notehub_report_async(boat_id_note_reason_t reason)
{
    const char *id = boat_id_get();
    if (id[0] == '\0') {
        return;
    }

    boat_id_note_args_t *args = (boat_id_note_args_t *)calloc(1, sizeof(*args));
    if (args == NULL) {
        ESP_LOGW(TAG, "note task alloc failed");
        return;
    }
    args->reason = reason;
    strncpy(args->id, id, sizeof(args->id) - 1U);

    if (xTaskCreate(boat_id_note_task, "boat_id_note", 4096, args, 3, NULL) != pdPASS) {
        ESP_LOGW(TAG, "note task create failed");
        free(args);
    }
}
