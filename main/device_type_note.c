#include "device_type_note.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "boat_id.h"
#include "blues_notecard.h"
#include "device_type.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "device_type_note";

#define DEVICE_TYPE_NOTE_FILE "device_type.qo"
#define DEVICE_TYPE_NOTE_PORT 12

typedef struct {
    device_type_note_reason_t reason;
    char type[DEVICE_TYPE_STR_MAX + 1U];
    char id[BOAT_ID_MAX_LEN + 1U];
} device_type_note_args_t;

static bool s_template_registered;

static const char *reason_string(device_type_note_reason_t reason)
{
    switch (reason) {
    case DEVICE_TYPE_NOTE_BOOT:
        return "boot";
    case DEVICE_TYPE_NOTE_SET:
        return "set";
    case DEVICE_TYPE_NOTE_CHANGED:
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

static bool device_type_note_ensure_template(void)
{
    if (s_template_registered) {
        return true;
    }

    char req[320];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"note.template\",\"file\":\"" DEVICE_TYPE_NOTE_FILE "\",\"port\":%d,\"body\":{"
                     "\"type\":\"xxxxxxxxxxxxxxxxxxxx\","
                     "\"reason\":\"xxxxxxx\","
                     "\"id\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\""
                     "}}\n",
                     DEVICE_TYPE_NOTE_PORT);
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
    ESP_LOGI(TAG, "registered template for " DEVICE_TYPE_NOTE_FILE);
    return true;
}

static void device_type_note_task(void *arg)
{
    device_type_note_args_t *args = (device_type_note_args_t *)arg;
    const char *reason = reason_string(args->reason);

    char type_esc[DEVICE_TYPE_STR_MAX * 2U + 1U];
    char id_esc[BOAT_ID_MAX_LEN * 2U + 1U];
    json_escape(args->type, type_esc, sizeof(type_esc));
    json_escape(args->id, id_esc, sizeof(id_esc));
    free(args);

    if (!device_type_note_ensure_template()) {
        ESP_LOGW(TAG, "skipped note.add reason=%s type=%s (no template)", reason, type_esc);
        vTaskDelete(NULL);
        return;
    }

    char req[256];
    int n = snprintf(req, sizeof(req),
                     "{\"req\":\"note.add\",\"file\":\"" DEVICE_TYPE_NOTE_FILE
                     "\",\"body\":{\"type\":\"%s\",\"reason\":\"%s\",\"id\":\"%s\"}}\n",
                     type_esc, reason, id_esc);
    if (n <= 0 || (size_t)n >= sizeof(req)) {
        ESP_LOGW(TAG, "note request too long");
        vTaskDelete(NULL);
        return;
    }

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(req, (size_t)n, &rsp);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "note.add failed (%s) reason=%s type=%s", esp_err_to_name(err), reason, type_esc);
    } else if (response_has_err(rsp)) {
        ESP_LOGW(TAG, "note.add rejected: %s", rsp);
    } else {
        ESP_LOGI(TAG, "note.add ok reason=%s type=%s id=%s", reason, type_esc, id_esc);
    }
    free(rsp);
    vTaskDelete(NULL);
}

void device_type_notehub_report_async(device_type_note_reason_t reason)
{
    device_type_note_args_t *args = (device_type_note_args_t *)calloc(1, sizeof(*args));
    if (args == NULL) {
        ESP_LOGW(TAG, "note task alloc failed");
        return;
    }
    args->reason = reason;
    strncpy(args->type, device_type_to_string(device_type_get()), sizeof(args->type) - 1U);
    strncpy(args->id, boat_id_get(), sizeof(args->id) - 1U);

    if (xTaskCreate(device_type_note_task, "dev_type_note", 4096, args, 3, NULL) != pdPASS) {
        ESP_LOGW(TAG, "note task create failed");
        free(args);
    }
}
