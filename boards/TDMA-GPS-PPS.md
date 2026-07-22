# GPS PPS, UTC timebase, and TDMA

How firmware turns GPS **PPS** + **NMEA UTC** into a shared **microsecond clock** and **TDMA** schedule. **LoRa** defaults to **CAD/CSMA only**; optional TDMA can gate LoRa TX when enabled. UWB (DWM3000) ranging is not TDMA-gated in current firmware.

Wiring and GPIO pins: **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** (GPS UART + PPS). UWB: **[WIRING-DWM3000.md](WIRING-DWM3000.md)**.

---

## Overview

| Layer | Source files | Role |
| ----- | ------------ | ---- |
| **GPS UART** | `main/gps_nmea.c` | NMEA → BLE `0xFEFD`; feeds UTC from `$xxRMC` |
| **PPS capture** | `main/gps_pps_capture.c` | MCPWM hardware latch on rising edge (ESP32-S3) |
| **HW clock** | `main/gps_hw_timer.c` | 1 MHz GPTimer; synced to MCPWM count each PPS |
| **UTC clock** | `main/gps_timebase.c` | PPS-disciplined **UTC microseconds** |
| **TDMA math** | `main/tdma.c` | UTC-aligned slot index / guards |
| **TDMA alarms** | `main/tdma_scheduler.c` | GPTimer one-shot open/close window |
| **LoRa TX** | `main/sx1262_lora.cpp` | CAD/CSMA queue (`scanChannel` + backoff); optional TDMA gate |

**ESP32-S3 default (v2):** PPS → **MCPWM capture** (hardware timestamp) → **GPTimer** synced each second → UTC extrapolation + optional **GPTimer slot alarms**.

**Legacy (v1):** GPIO ISR + `esp_timer_get_time()` — disable **MCPWM hardware capture** in menuconfig.

---

## Requirements

1. **`CONFIG_REGATTAONE_GPS_ENABLE=y`**
2. **PPS wired** — `GPS_PPS_GPIO` ≥ 0 (DevKit Mini: **21**, Waveshare Zero: **16**).
3. **GPS fix** — valid `$GNRMC` / `$GPRMC` with status `A`.
4. **`CONFIG_REGATTAONE_TDMA_ENABLE=y`**
5. **ESP32-S3** for hardware capture (default on S3 builds).

Until **PPS + RMC** sync: `gps_timebase_utc_valid()` is false. **LoRa** still transmits via CAD/CSMA unless you enable `TDMA_ENFORCE_LORA_TX`.

---

## menuconfig

**RegattaOne — GPS**

| Kconfig | Default (S3) | Description |
| ------- | ------------- | ----------- |
| `REGATTAONE_GPS_HW_CAPTURE` | y | MCPWM PPS capture + GPTimer timebase |

**RegattaOne — TDMA**

| Kconfig | Default | Description |
| ------- | ------- | ----------- |
| `REGATTAONE_TDMA_ENABLE` | y | Master enable |
| `TDMA_SLOT_US` | 100000 | Slot length (µs) |
| `TDMA_NUM_SLOTS` | 10 | Slots per frame |
| `TDMA_DEVICE_SLOT` | -1 | Slot index (-1 = hash boat ID) |
| `TDMA_GUARD_US` | 2000 | Guard band (µs) |
| `TDMA_GPTIMER_SCHEDULER` | y | Hardware alarms for slot open/close |
| `TDMA_ENFORCE_LORA_TX` | n | Block LoRa outside slot (off = CSMA/CAD only) |

---

## UTC timebase

### PPS (hardware capture)

On each rising PPS edge the MCPWM capture timer **latches** the count in hardware. The ISR:

1. Records `cap_value` (µs ticks at 1 MHz)
2. Sets the GPTimer count to that value (`gps_hw_timer_sync_to_capture`)
3. Advances UTC by +1 s when already synced

### NMEA UTC

Unchanged: `$xxRMC` with fix `A` snaps the UTC second label; PPS defines the tick.

### Reading time

```c
#include "gps_timebase.h"

if (gps_timebase_utc_valid()) {
    int64_t utc_us = gps_timebase_now_us();
}
```

| API | Meaning |
| --- | ------- |
| `gps_timebase_now_us()` | UTC estimate (µs) |
| `gps_timebase_last_pps_cap_ticks()` | MCPWM latched count (hw path) |
| `gps_timebase_last_pps_cap_delta_us()` | Interval since previous PPS (~1e6) |

---

## TDMA schedule

Slot math is unchanged:

```text
slot_index = (utc_us / TDMA_SLOT_US) % TDMA_NUM_SLOTS
```

When **`TDMA_GPTIMER_SCHEDULER`** is enabled:

- A GPTimer **one-shot** fires at slot open (start + guard)
- A second alarm fires at slot close
- `tdma_can_transmit_now()` is true while the hardware window flag is set
- High-priority `tdma_slot` task re-arms the next window after each alarm

---

## BLE / debug (`$PREGPPS`)

**Hardware capture** (6 fields with UTC):

```text
$PREGPPS,<mono_us>,<pulse_count>,<utc_us>,<cap_ticks>,<cap_delta_us>
```

**Before UTC sync** (empty UTC field):

```text
$PREGPPS,<mono_us>,<pulse_count>,,<cap_ticks>,<cap_delta_us>
```

**Legacy** (unchanged): 2 or 3 fields without `cap_*`.

**Prove capture on the bench:**

1. Plot `cap_delta_us` — should cluster around **1,000,000** with low spread under BLE/WiFi load.
2. Compare `mono_us` interval (GPTimer) vs `cap_delta_us` (MCPWM) — capture delta should be tighter under contention.
3. Log slot-open time vs `$PREGPPS` utc_us phase — GPTimer scheduler should land within tens of µs of guard.

---

## Source file map

| File | Purpose |
| ---- | ------- |
| `main/gps_pps_capture.c` | MCPWM PPS capture |
| `main/gps_hw_timer.c` | 1 MHz GPTimer |
| `main/gps_timebase.c` | UTC µs clock |
| `main/tdma_scheduler.c` | Slot open/close alarms |
| `main/tdma.c` | Slot math + gates |
| `main/gps_nmea.c` | UART, BLE, init order |

---

## Accuracy notes

| Layer | v1 (GPIO ISR) | v2 (MCPWM + GPTimer) |
| ----- | ------------- | --------------------- |
| PPS edge timestamp | ISR + `esp_timer` | Hardware latch |
| Slot open | Task polling | GPTimer alarm + flag |
| Radio TX window | Software / CAD | Same; optional TDMA gate for LoRa |

LoRa (100 ms slots): either path is fine. Measure `cap_delta_us` and guard bands when tightening slot timing.

Disable **`REGATTAONE_GPS_HW_CAPTURE`** to revert to v1 without removing TDMA.
