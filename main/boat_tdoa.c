#include "boat_tdoa.h"

#include "dwtime.h"

#include "esp_log.h"

#include <math.h>
#include <string.h>

static const char *TAG = "boat_tdoa";

#ifndef ANCHOR_DIST_UNKNOWN
#define ANCHOR_DIST_UNKNOWN 0xFFFFU
#endif

#define TDOA_MAX_ITERS 20
#define TDOA_EPS_M 1e-9
#define TDOA_MIN_BASELINE_M 0.05
#define TDOA_CONV_M 1e-4

static double hypot2(double dx, double dy)
{
    return sqrt(dx * dx + dy * dy);
}

static double clamp_nonneg(double v)
{
    return v > 0.0 ? v : TDOA_EPS_M;
}

static uint16_t metres_to_cm_u16(double m)
{
    if (!(m >= 0.0) || m > 655.34) {
        return ANCHOR_DIST_UNKNOWN;
    }
    const long cm = (long)(m * 100.0 + 0.5);
    if (cm < 0 || cm > 65534) {
        return ANCHOR_DIST_UNKNOWN;
    }
    return (uint16_t)cm;
}

/** Place Reference given P=(0,0), S=(b,0); choose y >= 0. */
static bool place_reference(double b, double pr, double sr, double *xr, double *yr)
{
    if (b < TDOA_MIN_BASELINE_M || pr < TDOA_MIN_BASELINE_M || sr < TDOA_MIN_BASELINE_M) {
        return false;
    }
    /* Triangle inequality (with small slack for TWR noise). */
    const double slack = 0.15;
    if (pr + sr + slack < b || pr + b + slack < sr || sr + b + slack < pr) {
        return false;
    }

    const double x = (b * b + pr * pr - sr * sr) / (2.0 * b);
    const double y2 = pr * pr - x * x;
    if (y2 < -0.05) {
        return false;
    }
    *xr = x;
    *yr = (y2 > 0.0) ? sqrt(y2) : 0.0;
    return true;
}

bool boat_tdoa_solve(uint32_t seq, uint64_t toa_p, uint64_t toa_s, uint64_t toa_r, uint64_t tx_p,
                     uint64_t tx_s, uint64_t tx_r, uint16_t ps_cm, uint16_t pr_cm, uint16_t sr_cm,
                     boat_tdoa_result_t *out)
{
    if (out == NULL) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    out->seq = seq;
    out->boat_port_cm = ANCHOR_DIST_UNKNOWN;
    out->boat_starboard_cm = ANCHOR_DIST_UNKNOWN;
    out->boat_reference_cm = ANCHOR_DIST_UNKNOWN;

    if (ps_cm == ANCHOR_DIST_UNKNOWN || pr_cm == ANCHOR_DIST_UNKNOWN ||
        sr_cm == ANCHOR_DIST_UNKNOWN || ps_cm == 0 || pr_cm == 0 || sr_cm == 0) {
        ESP_LOGW(TAG, "seq=%lu solve skipped — baseline unknown (ps=%u pr=%u sr=%u)",
                 (unsigned long)seq, (unsigned)ps_cm, (unsigned)pr_cm, (unsigned)sr_cm);
        return false;
    }

    const double b = (double)ps_cm / 100.0;
    const double pr = (double)pr_cm / 100.0;
    const double sr = (double)sr_cm / 100.0;

    double xr = 0.0;
    double yr = 0.0;
    if (!place_reference(b, pr, sr, &xr, &yr)) {
        ESP_LOGW(TAG, "seq=%lu solve skipped — cannot place Reference (ps=%.2f pr=%.2f sr=%.2f m)",
                 (unsigned long)seq, b, pr, sr);
        return false;
    }

    /* Range differences from TDoA (metres). */
    const int64_t dtoa_sp = (int64_t)toa_s - (int64_t)toa_p;
    const int64_t dtoa_rp = (int64_t)toa_r - (int64_t)toa_p;
    const int64_t dtx_sp = (int64_t)tx_s - (int64_t)tx_p;
    const int64_t dtx_rp = (int64_t)tx_r - (int64_t)tx_p;
    const double delta_sp = DTU_TO_DISTANCE((double)(dtoa_sp - dtx_sp));
    const double delta_rp = DTU_TO_DISTANCE((double)(dtoa_rp - dtx_rp));
    out->delta_sp_m = delta_sp;
    out->delta_rp_m = delta_rp;

    /* Physical bound: |r_i - r_j| cannot exceed the anchor baseline. */
    const double margin = 0.50;
    if (fabs(delta_sp) > b + margin || fabs(delta_rp) > pr + margin) {
        ESP_LOGW(TAG,
                 "seq=%lu reject impossible TDoA δsp=%.3f m (ps=%.2f) δrp=%.3f m (pr=%.2f)",
                 (unsigned long)seq, delta_sp, b, delta_rp, pr);
        out->residual_m = INFINITY;
        return false;
    }

    /* Initial guess: toward mid-baseline, on Reference side. */
    double x = b * 0.5 - 0.5 * delta_sp;
    double y = (yr > 0.5) ? (yr * 0.5) : 1.0;
    if (y < 0.1) {
        y = 0.1;
    }

    double residual = 1e9;
    bool converged = false;

    for (int iter = 0; iter < TDOA_MAX_ITERS; iter++) {
        const double d_p = clamp_nonneg(hypot2(x, y));
        const double d_s = clamp_nonneg(hypot2(x - b, y));
        const double d_r = clamp_nonneg(hypot2(x - xr, y - yr));

        const double f1 = (d_s - d_p) - delta_sp;
        const double f2 = (d_r - d_p) - delta_rp;
        residual = sqrt(0.5 * (f1 * f1 + f2 * f2));
        if (residual < TDOA_CONV_M) {
            converged = true;
            out->r_port_m = d_p;
            out->r_starboard_m = d_s;
            out->r_reference_m = d_r;
            break;
        }

        /* Jacobian of [dS-dP, dR-dP]. */
        const double j11 = (x - b) / d_s - x / d_p;
        const double j12 = y / d_s - y / d_p;
        const double j21 = (x - xr) / d_r - x / d_p;
        const double j22 = (y - yr) / d_r - y / d_p;

        const double det = j11 * j22 - j12 * j21;
        if (fabs(det) < 1e-12) {
            ESP_LOGW(TAG, "seq=%lu singular Jacobian at iter %d", (unsigned long)seq, iter);
            break;
        }

        /* Newton step: J * dx = -f */
        const double dx = (-f1 * j22 + f2 * j12) / det;
        const double dy = (-j11 * f2 + j21 * f1) / det;

        x += dx;
        y += dy;

        /* Prefer Reference / course side of the start line. */
        if (y < 0.0 && yr > 0.0) {
            y = -y;
        }

        out->r_port_m = clamp_nonneg(hypot2(x, y));
        out->r_starboard_m = clamp_nonneg(hypot2(x - b, y));
        out->r_reference_m = clamp_nonneg(hypot2(x - xr, y - yr));

        if (hypot2(dx, dy) < TDOA_CONV_M) {
            converged = true;
            residual = sqrt(0.5 * (f1 * f1 + f2 * f2));
            break;
        }
    }

    out->x_m = x;
    out->y_m = y;
    out->residual_m = residual;
    out->boat_port_cm = metres_to_cm_u16(out->r_port_m);
    out->boat_starboard_cm = metres_to_cm_u16(out->r_starboard_m);
    out->boat_reference_cm = metres_to_cm_u16(out->r_reference_m);

    /* Accept if residual is small enough for bring-up (loose on short baselines). */
    const double accept = (b < 2.0) ? 0.35 : 0.15;
    out->ok = converged && residual <= accept && out->boat_port_cm != ANCHOR_DIST_UNKNOWN;

    if (out->ok) {
        ESP_LOGI(TAG,
                 "seq=%lu fix x=%.3f m y=%.3f m | rP=%.3f rS=%.3f rR=%.3f | "
                 "δsp=%.3f δrp=%.3f resid=%.4f m",
                 (unsigned long)seq, out->x_m, out->y_m, out->r_port_m, out->r_starboard_m,
                 out->r_reference_m, out->delta_sp_m, out->delta_rp_m, out->residual_m);
    } else {
        ESP_LOGW(TAG,
                 "seq=%lu no fix (conv=%d resid=%.4f) x=%.3f y=%.3f δsp=%.3f δrp=%.3f",
                 (unsigned long)seq, (int)converged, residual, x, y, delta_sp, delta_rp);
    }
    return out->ok;
}
