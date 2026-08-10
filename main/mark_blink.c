#include "mark_blink.h"

#include "sdkconfig.h"

#if CONFIG_DW3000_RANGING_ENABLE

#include "device_type.h"
#include "dw3000_config.h"
#include "dw3000_ranging.h"
#include "boat_tdoa.h"

#if CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE
#include "mark_broadcast.h"
#endif

#include "dwmac.h"
#include "dwphy.h"
#include "dwproto.h"
#include "dwtime.h"
#include "mac802154.h"
#include "ranging.h"

#include "deca_device_api.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <math.h>
#include <string.h>

static const char *TAG = "mark_blink";

#ifndef CONFIG_MARK_BLINK_INTERVAL_MS
#define CONFIG_MARK_BLINK_INTERVAL_MS 1000
#endif
#ifndef CONFIG_MARK_BLINK_SLOT_STARBOARD_US
#define CONFIG_MARK_BLINK_SLOT_STARBOARD_US 5000
#endif
#ifndef CONFIG_MARK_BLINK_SLOT_REFERENCE_US
#define CONFIG_MARK_BLINK_SLOT_REFERENCE_US 10000
#endif
#ifndef CONFIG_MARK_BLINK_PORT_PREP_MS
#define CONFIG_MARK_BLINK_PORT_PREP_MS 2
#endif
#ifndef CONFIG_MARK_BLINK_ANCHOR_TWR_INTERVAL_MS
#define CONFIG_MARK_BLINK_ANCHOR_TWR_INTERVAL_MS 10000
#endif

#define ANCHOR_BEACON_VER 2U
#define GEOM_UNKNOWN ANCHOR_DIST_UNKNOWN

/** Quiet gap after Port TX (covers S/R slots + airtime) before baseline TWR. */
#define BEACON_SUPERFRAME_GUARD_MS 25U
/** Per-peer DS-TWR timeout (keep short so a miss doesn't eat the gap). */
#define ANCHOR_TWR_TIMEOUT_MS 400U
/** Do not start TWR if the next Port beacon is closer than this (covers one TWR). */
#define BEACON_TWR_PRE_GUARD_MS (ANCHOR_TWR_TIMEOUT_MS + 100U)
/** Max wait for a quiet window before skipping this TWR cycle. */
#define BEACON_TWR_QUIET_WAIT_MS 1500U

/**
 * v2 beacon — Port sync+pos or slave positioning.
 * tx_master_dtu: TX time on Port's master timeline (extended 40-bit in uint64).
 * slot_*_us: Starboard/Reference TX offsets from Port TX (master time).
 */
struct anchor_beacon_msg {
    uint8_t role;            /**< 'P' / 'S' / 'R' */
    uint8_t ver;             /**< ANCHOR_BEACON_VER */
    uint32_t seq;            /**< Superframe number (Port-owned) */
    uint16_t slot_s_us;      /**< S TX = Port TX + this (master) */
    uint16_t slot_r_us;      /**< R TX = Port TX + this (master) */
    uint64_t tx_master_dtu;  /**< This frame's TX time on master timeline */
    uint16_t dist_ps_cm;     /**< Port↔Starboard; 0xFFFF unknown */
    uint16_t dist_pr_cm;     /**< Port↔Reference */
    uint16_t dist_sr_cm;     /**< Starboard↔Reference */
    uint16_t geom_ver;       /**< Bumps when any baseline updates */
} __attribute__((packed));

/* --- shared geometry (beacon payload) --- */
static SemaphoreHandle_t s_geom_mtx;
static uint16_t s_dist_ps_cm = GEOM_UNKNOWN;
static uint16_t s_dist_pr_cm = GEOM_UNKNOWN;
static uint16_t s_dist_sr_cm = GEOM_UNKNOWN;
static uint16_t s_geom_ver;
static uint16_t s_uwb_starboard;
static uint16_t s_uwb_reference;
static uint16_t s_uwb_port;
static bool s_have_uwb_s;
static bool s_have_uwb_r;
static bool s_have_uwb_p;

static uint32_t s_port_seq;
static bool s_started;

/* Slave clock model: T_master ≈ alpha * R_local + beta */
static bool s_clk_valid;
static double s_clk_alpha = 1.0;
static double s_clk_beta;
static bool s_clk_have_prev;
static uint64_t s_clk_prev_r;
static uint64_t s_clk_prev_tm;

/* RX liveness (boat sniff + S/R Port-sync). Port TX is free-running and does not need this. */
static volatile int64_t s_last_blink_us;
static uint32_t s_rx_recoveries;
static uint32_t s_boat_last_seq;
static bool s_boat_have_p;
static bool s_boat_have_s;
static bool s_boat_have_r;
static uint64_t s_boat_toa_p;
static uint64_t s_boat_toa_s;
static uint64_t s_boat_toa_r;
static uint64_t s_boat_tx_p;
static uint64_t s_boat_tx_s;
static uint64_t s_boat_tx_r;

#define BLINK_RX_STALE_US (2500LL * 1000LL)
#define BLINK_RX_WATCHDOG_MS 1000U

/** Port's last successful beacon TX (master quiet-window reference). */
static volatile int64_t s_last_port_tx_us;

static void geom_lock(void)
{
    if (s_geom_mtx != NULL) {
        (void)xSemaphoreTake(s_geom_mtx, portMAX_DELAY);
    }
}

static void geom_unlock(void)
{
    if (s_geom_mtx != NULL) {
        xSemaphoreGive(s_geom_mtx);
    }
}

void mark_blink_set_geometry_cm(uint16_t dist_ps_cm, uint16_t dist_pr_cm, uint16_t dist_sr_cm)
{
    geom_lock();
    bool changed = false;
    if (dist_ps_cm != GEOM_UNKNOWN && dist_ps_cm != s_dist_ps_cm) {
        s_dist_ps_cm = dist_ps_cm;
        changed = true;
    }
    if (dist_pr_cm != GEOM_UNKNOWN && dist_pr_cm != s_dist_pr_cm) {
        s_dist_pr_cm = dist_pr_cm;
        changed = true;
    }
    if (dist_sr_cm != GEOM_UNKNOWN && dist_sr_cm != s_dist_sr_cm) {
        s_dist_sr_cm = dist_sr_cm;
        changed = true;
    }
    if (changed) {
        s_geom_ver++;
    }
    geom_unlock();
}

/**
 * Merge geometry using measurement authority only:
 *   Port owns ps + pr (initiates those TWRs)
 *   Starboard owns sr (initiates Starboard→Reference)
 *   Reference owns none
 *
 * Blind merge let Port's stale sr wipe Starboard's fresh TWR on every sync.
 */
static void geom_merge_from_beacon(const struct anchor_beacon_msg *msg)
{
    if (msg == NULL) {
        return;
    }
    uint16_t ps = GEOM_UNKNOWN;
    uint16_t pr = GEOM_UNKNOWN;
    uint16_t sr = GEOM_UNKNOWN;
    if (msg->role == ANCHOR_ROLE_PORT) {
        ps = msg->dist_ps_cm;
        pr = msg->dist_pr_cm;
    } else if (msg->role == ANCHOR_ROLE_STARBOARD) {
        sr = msg->dist_sr_cm;
    }
    mark_blink_set_geometry_cm(ps, pr, sr);
}

static void geom_snapshot(uint16_t *ps, uint16_t *pr, uint16_t *sr, uint16_t *ver)
{
    geom_lock();
    if (ps) {
        *ps = s_dist_ps_cm;
    }
    if (pr) {
        *pr = s_dist_pr_cm;
    }
    if (sr) {
        *sr = s_dist_sr_cm;
    }
    if (ver) {
        *ver = s_geom_ver;
    }
    geom_unlock();
}

void mark_blink_get_geometry_cm(uint16_t *dist_ps_cm, uint16_t *dist_pr_cm, uint16_t *dist_sr_cm,
                                uint16_t *geom_ver)
{
    geom_snapshot(dist_ps_cm, dist_pr_cm, dist_sr_cm, geom_ver);
}

static void note_peer_uwb(uint8_t role, uint16_t uwb)
{
    if (uwb == 0) {
        return;
    }
    geom_lock();
    if (role == ANCHOR_ROLE_PORT) {
        s_uwb_port = uwb;
        s_have_uwb_p = true;
    } else if (role == ANCHOR_ROLE_STARBOARD) {
        s_uwb_starboard = uwb;
        s_have_uwb_s = true;
    } else if (role == ANCHOR_ROLE_REFERENCE) {
        s_uwb_reference = uwb;
        s_have_uwb_r = true;
    }
    geom_unlock();
}

static uint16_t dist_to_port_cm(void)
{
    uint16_t ps = GEOM_UNKNOWN;
    uint16_t pr = GEOM_UNKNOWN;
    geom_snapshot(&ps, &pr, NULL, NULL);
    const device_type_t me = device_type_get();
    if (me == DEVICE_TYPE_STARBOARD) {
        return ps;
    }
    if (me == DEVICE_TYPE_REFERENCE) {
        return pr;
    }
    return GEOM_UNKNOWN;
}

/** Propagation Port→this slave in DTU (0 if unknown — OK on short bench). */
static double tau_to_port_dtu(void)
{
    const uint16_t cm = dist_to_port_cm();
    if (cm == GEOM_UNKNOWN) {
        return 0.0;
    }
    const double metres = (double)cm / 100.0;
    return metres / (SPEED_OF_LIGHT * DWT_TIME_UNITS);
}

static void clk_update_from_port(uint64_t rx_local, uint64_t tx_master)
{
    const double tau = tau_to_port_dtu();
    const double tm_arr = (double)tx_master + tau;

    if (!s_clk_have_prev) {
        s_clk_alpha = 1.0;
        s_clk_beta = tm_arr - (double)rx_local;
        s_clk_prev_r = rx_local;
        s_clk_prev_tm = (uint64_t)llround(tm_arr);
        s_clk_have_prev = true;
        s_clk_valid = true;
        ESP_LOGI(TAG, "clock sync init beta=%.0f tau_dtu=%.0f (dist_to_port=%u cm)", s_clk_beta, tau,
                 (unsigned)dist_to_port_cm());
        return;
    }

    const double dr = (double)rx_local - (double)s_clk_prev_r;
    const double dtm = tm_arr - (double)s_clk_prev_tm;
    if (fabs(dr) > 1000.0) {
        double alpha = dtm / dr;
        /* Reject absurd rate (clocks should be within tens of ppm). */
        if (alpha > 0.9999 && alpha < 1.0001) {
            s_clk_alpha = 0.8 * s_clk_alpha + 0.2 * alpha;
        }
    }
    s_clk_beta = tm_arr - s_clk_alpha * (double)rx_local;
    s_clk_prev_r = rx_local;
    s_clk_prev_tm = (uint64_t)llround(tm_arr);
    s_clk_valid = true;
}

static uint64_t master_to_local(uint64_t t_master)
{
    if (!s_clk_valid || s_clk_alpha == 0.0) {
        return t_master;
    }
    return (uint64_t)llround(((double)t_master - s_clk_beta) / s_clk_alpha);
}

static uint64_t local_to_master(uint64_t t_local)
{
    if (!s_clk_valid) {
        return t_local;
    }
    return (uint64_t)llround(s_clk_alpha * (double)t_local + s_clk_beta);
}

/*
 * DW3000 delayed TX discards the low 9 bits of the programmed time.  The TX
 * timestamp reported by the radio is that quantised time plus antenna delay.
 * Advertising the unquantised slot target creates up to 512 DTU (2.4 m) of
 * false range difference per anchor, which is fatal on a short baseline.
 */
static uint64_t delayed_tx_timestamp(uint64_t programmed_time)
{
    /* Preserve the software-extended epoch; only the radio register wraps at 40 bits. */
    return (programmed_time & ~UINT64_C(0x1FF)) + (uint64_t)DWPHY_ANTENNA_DELAY;
}

static void note_blink_rx(void)
{
    s_last_blink_us = esp_timer_get_time();
}

static bool tx_beacon(uint8_t role, uint32_t seq, uint64_t tx_master, uint64_t local_txtime)
{
    if (twr_in_progress()) {
        ESP_LOGD(TAG, "skip TX role=%c seq=%lu — TWR in progress", (char)role, (unsigned long)seq);
        return false;
    }

    struct txbuf *tx = dwmac_txbuf_get();
    if (tx == NULL) {
        ESP_LOGW(TAG, "TX role=%c seq=%lu — no txbuf", (char)role, (unsigned long)seq);
        return false;
    }

    uint16_t ps;
    uint16_t pr;
    uint16_t sr;
    uint16_t gver;
    geom_snapshot(&ps, &pr, &sr, &gver);

    struct anchor_beacon_msg *msg =
        dwprot_short_prepare(tx, sizeof(*msg), MARK_BLINK_MSG, 0xffff);
    msg->role = role;
    msg->ver = ANCHOR_BEACON_VER;
    msg->seq = seq;
    msg->slot_s_us = (uint16_t)CONFIG_MARK_BLINK_SLOT_STARBOARD_US;
    msg->slot_r_us = (uint16_t)CONFIG_MARK_BLINK_SLOT_REFERENCE_US;
    msg->tx_master_dtu = tx_master;
    msg->dist_ps_cm = ps;
    msg->dist_pr_cm = pr;
    msg->dist_sr_cm = sr;
    msg->geom_ver = gver;

    if (local_txtime != 0) {
        dwmac_tx_set_txtime(tx, local_txtime & DTU_DELAYEDTRX_MASK);
    }

    const bool ok = dwmac_transmit(tx);
    if (ok) {
        ESP_LOGI(TAG, "TX beacon role=%c seq=%lu master_tx=%llu local=%s geom_ver=%u ps=%u pr=%u sr=%u",
                 (char)role, (unsigned long)seq, (unsigned long long)tx_master,
                 local_txtime ? "delayed" : "now", (unsigned)gver,
                 ps == GEOM_UNKNOWN ? 0U : (unsigned)ps, pr == GEOM_UNKNOWN ? 0U : (unsigned)pr,
                 sr == GEOM_UNKNOWN ? 0U : (unsigned)sr);
    } else {
        ESP_LOGW(TAG, "TX beacon FAILED role=%c seq=%lu (slot may be too soon for PHY)", (char)role,
                 (unsigned long)seq);
    }
    return ok;
}

static void pull_lora_baseline(void)
{
#if CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE
    mark_broadcast_record_t port;
    mark_broadcast_record_t stb;
    const bool have_p = mark_broadcast_get_port(&port);
    const bool have_s = mark_broadcast_get_starboard(&stb);
    /* LoRa teaches Port/Starboard UWB addrs before (or without) hearing their beacons. */
    if (have_p && port.uwb_addr != 0) {
        note_peer_uwb(ANCHOR_ROLE_PORT, port.uwb_addr);
    }
    if (have_s && stb.uwb_addr != 0) {
        note_peer_uwb(ANCHOR_ROLE_STARBOARD, stb.uwb_addr);
    }
    const bool p_ok = have_p && port.dist_cm != MARK_BROADCAST_DIST_UNKNOWN;
    const bool s_ok = have_s && stb.dist_cm != MARK_BROADCAST_DIST_UNKNOWN;
    if (!p_ok && !s_ok) {
        return;
    }
    uint16_t bl;
    if (p_ok && s_ok) {
        bl = (uint16_t)(((uint32_t)port.dist_cm + (uint32_t)stb.dist_cm) / 2U);
    } else {
        bl = p_ok ? port.dist_cm : stb.dist_cm;
    }
    mark_blink_set_geometry_cm(bl, GEOM_UNKNOWN, GEOM_UNKNOWN);
#endif
}

/**
 * Partition initiators so links are not double-measured / collided:
 *   Port → Starboard (ps), Port → Reference (pr)
 *   Starboard → Reference (sr)
 *   Reference: respond only
 */
static int collect_twr_targets(uint16_t *targets, int max_n)
{
    if (targets == NULL || max_n <= 0) {
        return 0;
    }
    const device_type_t me = device_type_get();
    int n = 0;
    geom_lock();
    if (me == DEVICE_TYPE_PORT) {
        if (n < max_n && s_have_uwb_s) {
            targets[n++] = s_uwb_starboard;
        }
        if (n < max_n && s_have_uwb_r) {
            targets[n++] = s_uwb_reference;
        }
    } else if (me == DEVICE_TYPE_STARBOARD) {
        if (n < max_n && s_have_uwb_r) {
            targets[n++] = s_uwb_reference;
        }
    }
    geom_unlock();
    return n;
}

static void apply_twr_result(uint16_t peer, uint16_t cm)
{
    const device_type_t me = device_type_get();
    geom_lock();
    const bool to_s = s_have_uwb_s && peer == s_uwb_starboard;
    const bool to_r = s_have_uwb_r && peer == s_uwb_reference;
    geom_unlock();

    if (me == DEVICE_TYPE_PORT && to_s) {
        mark_blink_set_geometry_cm(cm, GEOM_UNKNOWN, GEOM_UNKNOWN);
        ESP_LOGI(TAG, "baseline ps=%u cm (Port→Starboard 0x%04X)", (unsigned)cm, (unsigned)peer);
    } else if (me == DEVICE_TYPE_PORT && to_r) {
        mark_blink_set_geometry_cm(GEOM_UNKNOWN, cm, GEOM_UNKNOWN);
        ESP_LOGI(TAG, "baseline pr=%u cm (Port→Reference 0x%04X)", (unsigned)cm, (unsigned)peer);
    } else if (me == DEVICE_TYPE_STARBOARD && to_r) {
        mark_blink_set_geometry_cm(GEOM_UNKNOWN, GEOM_UNKNOWN, cm);
        ESP_LOGI(TAG, "baseline sr=%u cm (Starboard→Reference 0x%04X)", (unsigned)cm, (unsigned)peer);
    }
}

/** True when UWB is past the beacon superframe and clear of the next Port edge. */
static bool in_beacon_quiet_window(void)
{
    const int64_t now = esp_timer_get_time();
    const int64_t guard_us = (int64_t)BEACON_SUPERFRAME_GUARD_MS * 1000LL;
    const int64_t pre_us = (int64_t)BEACON_TWR_PRE_GUARD_MS * 1000LL;
    const int64_t interval_us = (int64_t)CONFIG_MARK_BLINK_INTERVAL_MS * 1000LL;

    int64_t anchor_us = 0;
    if (device_type_get() == DEVICE_TYPE_PORT) {
        anchor_us = s_last_port_tx_us;
    } else {
        anchor_us = s_last_blink_us;
    }
    if (anchor_us <= 0) {
        return false;
    }

    const int64_t since = now - anchor_us;
    if (since < guard_us) {
        return false;
    }
    /* Phase within the Port beacon period (best-effort for S/R). */
    int64_t phase = since % interval_us;
    if (phase < 0) {
        phase += interval_us;
    }
    if (phase < guard_us) {
        return false;
    }
    if ((interval_us - phase) < pre_us) {
        return false;
    }
    return true;
}

static bool wait_beacon_quiet(uint32_t max_wait_ms)
{
    const int64_t deadline = esp_timer_get_time() + (int64_t)max_wait_ms * 1000LL;
    while (esp_timer_get_time() < deadline) {
        if (!twr_in_progress() && in_beacon_quiet_window()) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return false;
}

static void range_peers_in_gap(void)
{
    const dw3000_config_t *cfg = dw3000_config_get();
    if (cfg == NULL || !cfg->anchor_twr) {
        return;
    }

    const device_type_t me = device_type_get();
    if (me != DEVICE_TYPE_PORT && me != DEVICE_TYPE_STARBOARD) {
        /* Reference answers TWR but does not initiate. */
        return;
    }

#if CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE && CONFIG_MARK_BROADCAST_PEER_UWB_ADDR != 0
    /* Optional fixed opposite-mark address before LoRa/UWB discovery. */
    if (me == DEVICE_TYPE_PORT) {
        note_peer_uwb(ANCHOR_ROLE_STARBOARD, (uint16_t)CONFIG_MARK_BROADCAST_PEER_UWB_ADDR);
    } else if (me == DEVICE_TYPE_STARBOARD) {
        note_peer_uwb(ANCHOR_ROLE_PORT, (uint16_t)CONFIG_MARK_BROADCAST_PEER_UWB_ADDR);
    }
#endif

    uint16_t targets[2];
    const int n = collect_twr_targets(targets, 2);
    if (n == 0) {
        ESP_LOGD(TAG, "anchor TWR skipped — peer UWB addr not learned yet");
        return;
    }

    for (int i = 0; i < n; i++) {
        if (!wait_beacon_quiet(BEACON_TWR_QUIET_WAIT_MS)) {
            ESP_LOGW(TAG, "anchor TWR deferred — no quiet gap before next beacon");
            return;
        }
        if (twr_in_progress()) {
            return;
        }

        const uint16_t peer = targets[i];
        if (peer == 0 || peer == dw3000_ranging_self_addr()) {
            continue;
        }

        uint16_t cm = 0;
        const esp_err_t err = dw3000_range_to(peer, &cm, ANCHOR_TWR_TIMEOUT_MS);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "anchor TWR to 0x%04X failed (%s)", (unsigned)peer, esp_err_to_name(err));
        } else {
            apply_twr_result(peer, cm);
        }

        /* One peer per quiet gap — wait out this window before the next range. */
        if (i + 1 < n) {
            const int64_t leave_deadline = esp_timer_get_time() + 2000LL * 1000LL;
            while (esp_timer_get_time() < leave_deadline && in_beacon_quiet_window()) {
                vTaskDelay(pdMS_TO_TICKS(20));
            }
        }
    }
}

static void on_port_sync_for_slave(const struct anchor_beacon_msg *msg, uint16_t src, uint64_t rx_toa)
{
    note_blink_rx();
    note_peer_uwb(ANCHOR_ROLE_PORT, src);
    geom_merge_from_beacon(msg);
    pull_lora_baseline();
    clk_update_from_port(rx_toa, msg->tx_master_dtu);

    if (!s_clk_valid) {
        return;
    }

    const device_type_t me = device_type_get();
    uint16_t slot_us;
    uint8_t my_role;
    if (me == DEVICE_TYPE_STARBOARD) {
        slot_us = msg->slot_s_us ? msg->slot_s_us : (uint16_t)CONFIG_MARK_BLINK_SLOT_STARBOARD_US;
        my_role = ANCHOR_ROLE_STARBOARD;
    } else if (me == DEVICE_TYPE_REFERENCE) {
        slot_us = msg->slot_r_us ? msg->slot_r_us : (uint16_t)CONFIG_MARK_BLINK_SLOT_REFERENCE_US;
        my_role = ANCHOR_ROLE_REFERENCE;
    } else {
        return;
    }

    const uint64_t t_slot_master =
        msg->tx_master_dtu + (uint64_t)llround(US_TO_DTU((double)slot_us));
    /* Port advertises TX = programmed + antenna delay; program the same way. */
    const uint64_t local_target = master_to_local(t_slot_master);
    const uint64_t local_txtime =
        (local_target > (uint64_t)DWPHY_ANTENNA_DELAY)
            ? (local_target - (uint64_t)DWPHY_ANTENNA_DELAY)
            : local_target;
    const uint64_t actual_local_tx = delayed_tx_timestamp(local_txtime);
    const uint64_t actual_master_tx = local_to_master(actual_local_tx);

    ESP_LOGI(TAG, "RX Port sync seq=%lu — schedule %c at master+%u us (alpha=%.9f)",
             (unsigned long)msg->seq, (char)my_role, (unsigned)slot_us, s_clk_alpha);

    (void)tx_beacon(my_role, msg->seq, actual_master_tx, local_txtime);
}

static void boat_log_beacon(const struct anchor_beacon_msg *msg_in, uint16_t uwb, uint64_t toa)
{
    /* Snapshot before any logging — shared RX buf can be overwritten while UART blocks. */
    const struct anchor_beacon_msg msg = *msg_in;

    note_blink_rx();
    note_peer_uwb(msg.role, uwb);
    geom_merge_from_beacon(&msg);

    /* Collect the superframe before ESP_LOGI (USB UART can block > slot spacing). */
    if (msg.seq != s_boat_last_seq) {
        s_boat_last_seq = msg.seq;
        s_boat_have_p = s_boat_have_s = s_boat_have_r = false;
    }

    if (msg.role == ANCHOR_ROLE_PORT) {
        s_boat_have_p = true;
        s_boat_toa_p = toa;
        s_boat_tx_p = msg.tx_master_dtu;
    } else if (msg.role == ANCHOR_ROLE_STARBOARD) {
        s_boat_have_s = true;
        s_boat_toa_s = toa;
        s_boat_tx_s = msg.tx_master_dtu;
    } else if (msg.role == ANCHOR_ROLE_REFERENCE) {
        s_boat_have_r = true;
        s_boat_toa_r = toa;
        s_boat_tx_r = msg.tx_master_dtu;
    }

    ESP_LOGI(TAG,
             "beacon seq=%lu role=%c uwb=0x%04X ToA=%02x%02x%02x%02x%02x tx_master=%llu "
             "ps=%u pr=%u sr=%u geom_ver=%u",
             (unsigned long)msg.seq, (char)msg.role, (unsigned)uwb, (unsigned)((toa >> 32) & 0xff),
             (unsigned)((toa >> 24) & 0xff), (unsigned)((toa >> 16) & 0xff),
             (unsigned)((toa >> 8) & 0xff), (unsigned)(toa & 0xff),
             (unsigned long long)msg.tx_master_dtu,
             msg.dist_ps_cm == GEOM_UNKNOWN ? 0U : (unsigned)msg.dist_ps_cm,
             msg.dist_pr_cm == GEOM_UNKNOWN ? 0U : (unsigned)msg.dist_pr_cm,
             msg.dist_sr_cm == GEOM_UNKNOWN ? 0U : (unsigned)msg.dist_sr_cm,
             (unsigned)msg.geom_ver);

    if (!(s_boat_have_p && s_boat_have_s && s_boat_have_r)) {
        return;
    }

    const int64_t d_sp = (int64_t)s_boat_toa_s - (int64_t)s_boat_toa_p;
    const int64_t d_rp = (int64_t)s_boat_toa_r - (int64_t)s_boat_toa_p;
    const int64_t tx_sp = (int64_t)s_boat_tx_s - (int64_t)s_boat_tx_p;
    const int64_t tx_rp = (int64_t)s_boat_tx_r - (int64_t)s_boat_tx_p;
    ESP_LOGI(TAG,
             "triple seq=%lu dToA_S-P=%lld dToA_R-P=%lld dTX_S-P=%lld dTX_R-P=%lld",
             (unsigned long)msg.seq, (long long)d_sp, (long long)d_rp, (long long)tx_sp,
             (long long)tx_rp);

    uint16_t ps = GEOM_UNKNOWN;
    uint16_t pr = GEOM_UNKNOWN;
    uint16_t sr = GEOM_UNKNOWN;
    geom_snapshot(&ps, &pr, &sr, NULL);
    if (msg.role == ANCHOR_ROLE_PORT) {
        if (msg.dist_ps_cm != GEOM_UNKNOWN) {
            ps = msg.dist_ps_cm;
        }
        if (msg.dist_pr_cm != GEOM_UNKNOWN) {
            pr = msg.dist_pr_cm;
        }
    } else if (msg.role == ANCHOR_ROLE_STARBOARD) {
        if (msg.dist_sr_cm != GEOM_UNKNOWN) {
            sr = msg.dist_sr_cm;
        }
    }

    boat_tdoa_result_t fix;
    const bool ok =
        boat_tdoa_solve(msg.seq, s_boat_toa_p, s_boat_toa_s, s_boat_toa_r, s_boat_tx_p, s_boat_tx_s,
                        s_boat_tx_r, ps, pr, sr, &fix);
#if CONFIG_REGATTAONE_MARK_BROADCAST_ENABLE
    mark_broadcast_publish_boat_tdoa(fix.seq, ok, fix.x_m, fix.y_m, fix.residual_m, fix.delta_sp_m,
                                     fix.delta_rp_m, fix.boat_port_cm, fix.boat_starboard_cm,
                                     fix.boat_reference_cm);
#else
    (void)ok;
#endif
    s_boat_have_p = s_boat_have_s = s_boat_have_r = false;
}

bool mark_blink_try_handle(const struct rxbuf *rx)
{
    if (rx == NULL || rx->len < 2) {
        return false;
    }

    const uint16_t fc = *(const uint16_t *)rx->buf;
    if ((fc & MAC154_FC_TYPE_DATA) == 0) {
        return false;
    }
    if (!dwprot_check_min_len(rx->buf, rx->len)) {
        return false;
    }
    if (dwprot_get_func(rx->buf) != MARK_BLINK_MSG) {
        return false;
    }

    const size_t plen = dwprot_get_payload_len(rx->buf, rx->len);
    /* Accept v2; ignore legacy v1 7-byte blinks quietly. */
    if (plen != sizeof(struct anchor_beacon_msg)) {
        ESP_LOGD(TAG, "drop beacon: payload len %u (want %u)", (unsigned)plen,
                 (unsigned)sizeof(struct anchor_beacon_msg));
        return true;
    }

    const struct anchor_beacon_msg *msg = dwprot_get_payload(rx->buf);
    if (msg->ver != ANCHOR_BEACON_VER) {
        ESP_LOGD(TAG, "drop beacon: ver %u", (unsigned)msg->ver);
        return true;
    }

    const uint16_t src = (uint16_t)dwprot_get_src(rx->buf);
    const uint64_t toa = dw_timestamp_extend(rx->ts & DTU_MASK);
    const device_type_t me = device_type_get();

    note_peer_uwb(msg->role, src);

    if ((me == DEVICE_TYPE_STARBOARD || me == DEVICE_TYPE_REFERENCE) && msg->role == ANCHOR_ROLE_PORT) {
        on_port_sync_for_slave(msg, src, toa);
        return true;
    }

    if (me == DEVICE_TYPE_BOAT) {
        boat_log_beacon(msg, src, toa);
        return true;
    }

    /* Other anchors: merge geometry / peer addrs from overheard beacons. */
    if (device_type_is_course_mark(me) && msg->role != ANCHOR_ROLE_PORT) {
        geom_merge_from_beacon(msg);
        ESP_LOGD(TAG, "RX peer beacon role=%c seq=%lu uwb=0x%04X", (char)msg->role,
                 (unsigned long)msg->seq, (unsigned)src);
        return true;
    }

    ESP_LOGD(TAG, "RX beacon role=%c seq=%lu uwb=0x%04X (ignored locally)", (char)msg->role,
             (unsigned long)msg->seq, (unsigned)src);
    return true;
}

static void port_master_task(void *arg)
{
    (void)arg;
    const uint32_t interval_ms = (uint32_t)CONFIG_MARK_BLINK_INTERVAL_MS;
    const uint32_t prep_ms = (uint32_t)CONFIG_MARK_BLINK_PORT_PREP_MS;

    vTaskDelay(pdMS_TO_TICKS(200 + (dw3000_ranging_self_addr() & 0x1FFU)));

    for (;;) {
        if (device_type_get() == DEVICE_TYPE_PORT) {
            pull_lora_baseline();

            /* Never run TWR here — prep slack is only a few ms and TWR would
             * steal it (late delayed-TX). Baseline ranging lives in the gap. */
            uint64_t send_dtu = dw_timestamp_extend(dw_get_systime());
            send_dtu += (uint64_t)MS_TO_DTU((double)prep_ms);
            /* Advertise the timestamp the delayed-TX hardware will actually use. */
            const uint64_t tx_master = delayed_tx_timestamp(send_dtu);
            const uint32_t seq = ++s_port_seq;
            if (tx_beacon(ANCHOR_ROLE_PORT, seq, tx_master, send_dtu)) {
                s_last_port_tx_us = esp_timer_get_time();
            }
        }
        vTaskDelay(pdMS_TO_TICKS(interval_ms));
    }
}

/**
 * Course-mark baseline TWR in the post-superframe quiet gap.
 * Beacons only skip when twr_in_progress() at TX time (rare if timing holds).
 */
static void anchor_twr_task(void *arg)
{
    (void)arg;
    const uint32_t interval_ms = (uint32_t)CONFIG_MARK_BLINK_ANCHOR_TWR_INTERVAL_MS;

    /* Stagger first cycle: Port earlier in the gap, Starboard later (avoids R clash). */
    uint32_t boot_delay_ms = 1500;
    if (device_type_get() == DEVICE_TYPE_STARBOARD) {
        boot_delay_ms = 1800;
    } else if (device_type_get() == DEVICE_TYPE_REFERENCE) {
        boot_delay_ms = 2000; /* respond-only; still runs so enable/disable is live */
    }
    boot_delay_ms += (dw3000_ranging_self_addr() & 0x7FU) * 5U;
    vTaskDelay(pdMS_TO_TICKS(boot_delay_ms));

    for (;;) {
        const device_type_t me = device_type_get();
        if (device_type_is_course_mark(me)) {
            pull_lora_baseline();
            range_peers_in_gap();
        }
        vTaskDelay(pdMS_TO_TICKS(interval_ms));
    }
}

/**
 * Port beacons on a free-running timer and does not need RX to keep TX alive.
 * Starboard/Reference only TX after hearing Port, so a stuck UWB RX silences them
 * permanently. Boat is RX-only sniff. Same Meshtastic/load stall that needed a
 * boat watchdog also hits S/R — recover with forcetrxoff + RX re-arm.
 */
static void blink_rx_watchdog_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(BLINK_RX_WATCHDOG_MS));
        const device_type_t me = device_type_get();
        if (me != DEVICE_TYPE_BOAT && me != DEVICE_TYPE_STARBOARD && me != DEVICE_TYPE_REFERENCE) {
            continue;
        }
        if (twr_in_progress()) {
            continue;
        }

        const int64_t now = esp_timer_get_time();
        const int64_t last = s_last_blink_us;
        const int64_t age_us = (last > 0) ? (now - last) : now;

        dwmac_rx_reenable();

        if (age_us < BLINK_RX_STALE_US) {
            continue;
        }

        s_rx_recoveries++;
        const char *who = me == DEVICE_TYPE_BOAT       ? "boat"
                          : me == DEVICE_TYPE_STARBOARD ? "starboard"
                                                        : "reference";
        ESP_LOGW(TAG,
                 "%s UWB RX stale (no Port/beacon for %lld ms) — forcetrxoff + RX re-arm #%lu",
                 who, (long long)(age_us / 1000), (unsigned long)s_rx_recoveries);
        dwt_forcetrxoff();
        dwmac_rx_reenable();
    }
}

static esp_err_t start_blink_rx_watchdog(void)
{
    if (xTaskCreate(blink_rx_watchdog_task, "blink_wd", 3072, NULL, 6, NULL) != pdPASS) {
        ESP_LOGE(TAG, "blink RX watchdog create failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t mark_blink_start(void)
{
    if (s_started) {
        return ESP_OK;
    }

    if (s_geom_mtx == NULL) {
        s_geom_mtx = xSemaphoreCreateMutex();
        if (s_geom_mtx == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    const device_type_t t = device_type_get();
    if (t == DEVICE_TYPE_PORT) {
        if (xTaskCreate(port_master_task, "anchor_master", 4096, NULL, 5, NULL) != pdPASS) {
            ESP_LOGE(TAG, "port master task create failed");
            return ESP_FAIL;
        }
        ESP_LOGI(TAG,
                 "Port master started (interval=%u ms, prep=%u ms, slot_S=%u us, slot_R=%u us)",
                 (unsigned)CONFIG_MARK_BLINK_INTERVAL_MS, (unsigned)CONFIG_MARK_BLINK_PORT_PREP_MS,
                 (unsigned)CONFIG_MARK_BLINK_SLOT_STARBOARD_US,
                 (unsigned)CONFIG_MARK_BLINK_SLOT_REFERENCE_US);
    } else if (t == DEVICE_TYPE_STARBOARD || t == DEVICE_TYPE_REFERENCE) {
        s_last_blink_us = 0;
        if (start_blink_rx_watchdog() != ESP_OK) {
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "%s slave armed (master=Port, slot=%u us, RX watchdog on)",
                 t == DEVICE_TYPE_STARBOARD ? "Starboard" : "Reference",
                 (unsigned)(t == DEVICE_TYPE_STARBOARD ? CONFIG_MARK_BLINK_SLOT_STARBOARD_US
                                                       : CONFIG_MARK_BLINK_SLOT_REFERENCE_US));
    } else if (t == DEVICE_TYPE_BOAT) {
        s_last_blink_us = 0;
        if (start_blink_rx_watchdog() != ESP_OK) {
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "Boat beacon sniff + TDoA solve armed (UWB TX suppressed)");
    } else {
        ESP_LOGI(TAG, "mark blink idle (device type %d)", (int)t);
    }

    if (device_type_is_course_mark(t)) {
        if (xTaskCreate(anchor_twr_task, "anchor_twr", 4096, NULL, 4, NULL) != pdPASS) {
            ESP_LOGE(TAG, "anchor TWR task create failed");
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "anchor baseline TWR task started (interval=%u ms, default/NVS via anchor_twr)",
                 (unsigned)CONFIG_MARK_BLINK_ANCHOR_TWR_INTERVAL_MS);
    }

    s_started = true;
    return ESP_OK;
}

#else /* !CONFIG_DW3000_RANGING_ENABLE */

bool mark_blink_try_handle(const struct rxbuf *rx)
{
    (void)rx;
    return false;
}

esp_err_t mark_blink_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void mark_blink_set_geometry_cm(uint16_t dist_ps_cm, uint16_t dist_pr_cm, uint16_t dist_sr_cm)
{
    (void)dist_ps_cm;
    (void)dist_pr_cm;
    (void)dist_sr_cm;
}

void mark_blink_get_geometry_cm(uint16_t *dist_ps_cm, uint16_t *dist_pr_cm, uint16_t *dist_sr_cm,
                                uint16_t *geom_ver)
{
    if (dist_ps_cm) {
        *dist_ps_cm = ANCHOR_DIST_UNKNOWN;
    }
    if (dist_pr_cm) {
        *dist_pr_cm = ANCHOR_DIST_UNKNOWN;
    }
    if (dist_sr_cm) {
        *dist_sr_cm = ANCHOR_DIST_UNKNOWN;
    }
    if (geom_ver) {
        *geom_ver = 0;
    }
}

#endif
