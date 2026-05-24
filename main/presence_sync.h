#pragma once

#include <stddef.h>
#include <stdbool.h>

/** Start background task: hub.sync, drain presence.qi, apply deltas, ack on presence_ack.qo. */
void presence_sync_start(void);

/** Number of peers currently tracked (online and offline). */
size_t presence_peer_count(void);

/** Copy peer device id at index (0 .. count-1). Returns false if out of range. */
bool presence_peer_get(size_t index, char *id_out, size_t id_cap, char *type_out, size_t type_cap,
                       bool *online_out);
