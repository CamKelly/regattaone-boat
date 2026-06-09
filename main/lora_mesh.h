/*
 * LoRa democratic mesh ID mode — ephemeral 16-bit IDs + heartbeats (RAM only).
 * Binary on-air heartbeat: magic 'M' + id(2 BE) + type(1) = 4 bytes.
 * Duplicate-ID collisions: random backoff (1–5 s) then repick (no MAC on air).
 */
#pragma once

#include "sdkconfig.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LORA_MESH_PKT_LEN       4U
#define LORA_MESH_MAGIC         0x4DU

typedef enum {
    LORA_MESH_STATE_OFF = 0,
    LORA_MESH_STATE_LISTENING,
    LORA_MESH_STATE_LOCKED,
} lora_mesh_state_t;

#if CONFIG_REGATTAONE_SX1262_ENABLE

void lora_mesh_init(void);
void lora_mesh_start_task(void);

void lora_mesh_set_active(bool active);
bool lora_mesh_active(void);
lora_mesh_state_t lora_mesh_get_state(void);

/** Periodic tick (listen timeout, reclaim, heartbeat schedule). */
void lora_mesh_tick(int64_t now_us);

/** Parse a validated mesh heartbeat RX. */
void lora_mesh_on_rx(const uint8_t *data, size_t len, int64_t now_us);

/** Build this node's heartbeat into @p out (LORA_MESH_PKT_LEN bytes). */
void lora_mesh_build_heartbeat(uint8_t out[LORA_MESH_PKT_LEN]);

/** True if a heartbeat TX is due (caller sends via sx1262_lora_mesh_transmit). */
bool lora_mesh_heartbeat_due(int64_t now_us);

/** Append `"mesh":{...}` into JSON at @p pos; returns false if truncated. */
bool lora_mesh_append_json(char *out, size_t out_cap, size_t *pos);

#else

static inline void lora_mesh_init(void) {}
static inline void lora_mesh_start_task(void) {}
static inline void lora_mesh_set_active(bool active)
{
    (void)active;
}
static inline bool lora_mesh_active(void)
{
    return false;
}
static inline lora_mesh_state_t lora_mesh_get_state(void)
{
    return LORA_MESH_STATE_OFF;
}
static inline void lora_mesh_tick(int64_t now_us)
{
    (void)now_us;
}
static inline void lora_mesh_on_rx(const uint8_t *data, size_t len, int64_t now_us)
{
    (void)data;
    (void)len;
    (void)now_us;
}
static inline void lora_mesh_build_heartbeat(uint8_t out[LORA_MESH_PKT_LEN])
{
    (void)out;
}
static inline bool lora_mesh_heartbeat_due(int64_t now_us)
{
    (void)now_us;
    return false;
}
static inline bool lora_mesh_append_json(char *out, size_t out_cap, size_t *pos)
{
    (void)out;
    (void)out_cap;
    (void)pos;
    return true;
}

#endif

#ifdef __cplusplus
}
#endif
