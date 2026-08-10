#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Passive boat TDoA solve from one Port/Starboard/Reference beacon superframe.
 *
 * Local frame: Port at (0,0), Starboard at (ps, 0), Reference at y >= 0.
 * Uses range differences:
 *   r_S - r_P = c * ((ToA_S - ToA_P) - (TX_S - TX_P))
 *   r_R - r_P = c * ((ToA_R - ToA_P) - (TX_R - TX_P))
 */

typedef struct {
    uint32_t seq;
    bool ok;
    double x_m;              /**< metres; Port origin, Starboard +X */
    double y_m;              /**< metres; Reference side is +Y */
    double reference_x_m;    /**< Reference anchor X in the same local frame */
    double reference_y_m;    /**< Reference anchor Y in the same local frame */
    double r_port_m;
    double r_starboard_m;
    double r_reference_m;
    double delta_sp_m;       /**< r_S - r_P */
    double delta_rp_m;       /**< r_R - r_P */
    double residual_m;       /**< RMS TDoA residual after solve */
    uint16_t boat_port_cm;
    uint16_t boat_starboard_cm;
    uint16_t boat_reference_cm;
} boat_tdoa_result_t;

/**
 * Solve boat position. Baselines in cm; timestamps in DW3000 DTU (extended).
 * Returns true when out->ok is set (usable fix).
 */
bool boat_tdoa_solve(uint32_t seq, uint64_t toa_p, uint64_t toa_s, uint64_t toa_r, uint64_t tx_p,
                     uint64_t tx_s, uint64_t tx_r, uint16_t ps_cm, uint16_t pr_cm, uint16_t sr_cm,
                     boat_tdoa_result_t *out);

#ifdef __cplusplus
}
#endif
