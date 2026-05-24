#pragma once

/** Report current boat id + device type to Notehub (async, non-blocking). */
typedef enum {
    BOAT_NOTE_BOOT,
    BOAT_NOTE_SET,
    BOAT_NOTE_CHANGED,
} boat_note_reason_t;

/** Queue a note.add to Notehub on file boat.qo with id, type, and reason. */
void boat_notehub_report_async(boat_note_reason_t reason);
