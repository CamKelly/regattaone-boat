#include "tdma.h"

#include "boat_id.h"
#include "esp_timer.h"
#include "gps_timebase.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_TDMA_ENABLE

static uint32_t hash_boat_id_slot(void)
{
    const char *id = boat_id_get();
    uint32_t h = 2166136261U;
    if (id && id[0] != '\0') {
        for (const unsigned char *p = (const unsigned char *)id; *p; p++) {
            h ^= *p;
            h *= 16777619U;
        }
    } else {
        h ^= (uint32_t)esp_timer_get_time();
    }
    const uint32_t n = (uint32_t)CONFIG_TDMA_NUM_SLOTS;
    return n > 0U ? h % n : 0U;
}

int64_t tdma_slot_us(void)
{
    return (int64_t)CONFIG_TDMA_SLOT_US;
}

uint32_t tdma_num_slots(void)
{
    return (uint32_t)CONFIG_TDMA_NUM_SLOTS;
}

uint32_t tdma_device_slot(void)
{
#if CONFIG_TDMA_DEVICE_SLOT >= 0
    const uint32_t n = (uint32_t)CONFIG_TDMA_NUM_SLOTS;
    const uint32_t s = (uint32_t)CONFIG_TDMA_DEVICE_SLOT;
    return n > 0U ? s % n : 0U;
#else
    return hash_boat_id_slot();
#endif
}

uint32_t tdma_slot_index(int64_t utc_us)
{
    const int64_t slot_us = tdma_slot_us();
    const uint32_t n = tdma_num_slots();
    if (slot_us <= 0 || n == 0U || utc_us <= 0) {
        return 0U;
    }
    int64_t idx = (utc_us / slot_us) % (int64_t)n;
    if (idx < 0) {
        idx += (int64_t)n;
    }
    return (uint32_t)idx;
}

static int64_t slot_phase_us(int64_t utc_us)
{
    const int64_t slot_us = tdma_slot_us();
    if (slot_us <= 0) {
        return 0;
    }
    int64_t phase = utc_us % slot_us;
    if (phase < 0) {
        phase += slot_us;
    }
    return phase;
}

bool tdma_in_tx_window(int64_t utc_us)
{
    if (utc_us <= 0) {
        return false;
    }
    if (tdma_slot_index(utc_us) != tdma_device_slot()) {
        return false;
    }
    const int64_t guard = (int64_t)CONFIG_TDMA_GUARD_US;
    const int64_t slot_us = tdma_slot_us();
    const int64_t phase = slot_phase_us(utc_us);
    return phase >= guard && phase <= slot_us - guard;
}

bool tdma_can_transmit_now(void)
{
    if (!gps_timebase_utc_valid()) {
        return false;
    }
    return tdma_in_tx_window(gps_timebase_now_us());
}

int64_t tdma_us_until_tx_window(void)
{
    if (!gps_timebase_utc_valid()) {
        return -1;
    }
    const int64_t now = gps_timebase_now_us();
    if (tdma_in_tx_window(now)) {
        return 0;
    }

    const int64_t slot_us = tdma_slot_us();
    const uint32_t n = tdma_num_slots();
    const uint32_t mine = tdma_device_slot();
    if (slot_us <= 0 || n == 0U) {
        return -1;
    }

    const int64_t guard = (int64_t)CONFIG_TDMA_GUARD_US;
    const int64_t phase = slot_phase_us(now);
    const uint32_t cur = tdma_slot_index(now);

    if (cur == mine) {
        if (phase < guard) {
            return guard - phase;
        }
        const int64_t to_slot_end = slot_us - phase;
        return to_slot_end + (int64_t)(n - 1U) * slot_us + guard;
    }

    uint32_t delta_slots = (mine + n - cur) % n;
    const int64_t to_slot_end = slot_us - phase;
    return to_slot_end + (int64_t)(delta_slots - 1U) * slot_us + guard;
}

int64_t tdma_us_remaining_in_slot(void)
{
    if (!gps_timebase_utc_valid()) {
        return 0;
    }
    const int64_t now = gps_timebase_now_us();
    if (!tdma_in_tx_window(now)) {
        return 0;
    }
    const int64_t slot_us = tdma_slot_us();
    const int64_t guard = (int64_t)CONFIG_TDMA_GUARD_US;
    const int64_t phase = slot_phase_us(now);
    return slot_us - guard - phase;
}

#endif /* CONFIG_REGATTAONE_TDMA_ENABLE */
