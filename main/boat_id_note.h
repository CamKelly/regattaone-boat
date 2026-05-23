#pragma once

/** Report current boat ID to Notehub (async, non-blocking). */
typedef enum {
    BOAT_ID_NOTE_BOOT,
    BOAT_ID_NOTE_SET,
    BOAT_ID_NOTE_CHANGED,
} boat_id_note_reason_t;

/** Queue a note.add to Notehub; no-op if id is empty or Notecard is unavailable. */
void boat_id_notehub_report_async(boat_id_note_reason_t reason);
