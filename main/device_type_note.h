#pragma once

typedef enum {
    DEVICE_TYPE_NOTE_BOOT,
    DEVICE_TYPE_NOTE_SET,
    DEVICE_TYPE_NOTE_CHANGED,
} device_type_note_reason_t;

/** Queue device_type.qo note.add to Notehub (async). Always includes type; id if set. */
void device_type_notehub_report_async(device_type_note_reason_t reason);
