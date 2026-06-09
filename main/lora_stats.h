/*
 * LoRa TX/RX statistics (RAM only — reset on power cycle).
 * Exposed on BLE 0xFEFE (read JSON, notify on change, write stream=0|1).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LORA_STATS_MAX_SENDERS 32

/** Stream auto-send gate (web writes stream=1 / stream=0 to 0xFEFE). */
void lora_stats_set_stream_active(bool active);
bool lora_stats_stream_active(void);

#if CONFIG_REGATTAONE_SX1262_ENABLE

void lora_stats_tx_stream_queued(void);
void lora_stats_tx_stream_ok(void);
void lora_stats_tx_stream_timeout(void);
void lora_stats_rx_bad(void);
/** Payload text after "RX … : " (e.g. "patio #424"). */
void lora_stats_rx_packet(const char *payload, size_t len);

void lora_stats_mesh_tx_ok(void);
void lora_stats_mesh_tx_fail(void);
void lora_stats_mesh_rx_heartbeat(void);
void lora_stats_request_notify(void);

/** Format JSON into @p out (NUL-terminated). Returns bytes written (excl. NUL). */
size_t lora_stats_format_json(char *out, size_t out_cap);

#else

static inline void lora_stats_tx_stream_queued(void) {}
static inline void lora_stats_tx_stream_ok(void) {}
static inline void lora_stats_tx_stream_timeout(void) {}
static inline void lora_stats_rx_bad(void) {}
static inline void lora_stats_rx_packet(const char *payload, size_t len)
{
    (void)payload;
    (void)len;
}
static inline size_t lora_stats_format_json(char *out, size_t out_cap)
{
    if (out_cap > 0) {
        out[0] = '\0';
    }
    return 0;
}

#endif

#ifdef __cplusplus
}
#endif
