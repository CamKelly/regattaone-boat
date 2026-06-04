# GPS PPS, UTC timebase, and TDMA

How firmware turns GPS **PPS** + **NMEA UTC** into a shared **microsecond clock** and **TDMA** (time-division multiple access) schedule for **LoRa** and **REYAX UWB**.

Wiring and GPIO pins: **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** (GPS UART + PPS).

---

## Overview

| Layer | Source files | Role |
| ----- | ------------ | ---- |
| **GPS UART** | `main/gps_nmea.c` | NMEA → BLE `0xFEFD`; feeds UTC from `$xxRMC` |
| **PPS GPIO** | `main/gps_nmea.c` | 1 Hz rising edge → UTC second boundaries |
| **UTC clock** | `main/gps_timebase.c` | PPS-disciplined **UTC microseconds** (1 µs resolution) |
| **TDMA** | `main/tdma.c` | UTC-aligned TX slots for LoRa / UWB |
| **LoRa gate** | `main/sx1262_lora.cpp` | `sx1262_lora_transmit()` blocked outside slot |
| **UWB gate** | `main/ryuw122_uart.c` | `ryuw122_tdma_can_use_now()` for timed UWB |

**Precision:** ESP32 uses `esp_timer_get_time()` — **1 µs** ticks. PPS is captured in a GPIO ISR; between PPS edges UTC time is linearly extrapolated. This is suitable for millisecond-scale TDMA slots; absolute jitter is dominated by PPS ISR latency (typically tens of µs).

---

## Requirements

1. **`CONFIG_REGATTAONE_GPS_ENABLE=y`**
2. **PPS wired** — `GPS_PPS_GPIO` ≥ 0 (DevKit Mini: **21**, Waveshare Zero: **16**). Do **not** use `-1` if you need TDMA.
3. **GPS fix** — valid `$GNRMC` / `$GPRMC` with status `A` for UTC alignment.
4. **`CONFIG_REGATTAONE_TDMA_ENABLE=y`** (default when GPS is on).

Until **PPS + RMC** sync: `gps_timebase_utc_valid()` is false and TDMA TX is blocked.

---

## UTC timebase

### PPS (pulse per second)

- Configured as **GPIO input**, **rising edge** interrupt.
- Each pulse:
  - Increments pulse counter
  - Records `esp_timer_get_time()` at the edge
  - If UTC is already valid, advances the UTC second by **+1 s** (PPS marks the start of each UTC second when GPS is locked)

### NMEA UTC

- On each complete NMEA line, `$xxRMC` with fix status **`A`** is parsed (time + date fields).
- First valid RMC **snaps** UTC to the reported second (adjusted for time since last PPS if PPS already seen).
- Later RMC lines refine only if off by more than ~1 s.

### Reading time

```c
#include "gps_timebase.h"

if (gps_timebase_utc_valid()) {
    int64_t utc_us = gps_timebase_now_us();  // µs since Unix epoch
}
```

| API | Meaning |
| --- | ------- |
| `gps_timebase_now_us()` | Current UTC estimate (µs); **0** if not synced |
| `gps_timebase_utc_valid()` | PPS seen + RMC alignment trusted |
| `gps_timebase_pps_locked()` | At least one PPS received |
| `gps_timebase_pps_count()` | PPS edges since boot |
| `gps_timebase_last_pps_esp_us()` | `esp_timer` value at last PPS |

---

## TDMA schedule

All nodes compute the **same slot index** from UTC so frames align network-wide.

### menuconfig

**Component config → RegattaOne — TDMA (PPS-synchronized UTC slots)**

| Kconfig | Default | Description |
| ------- | ------- | ----------- |
| `REGATTAONE_TDMA_ENABLE` | y | Master enable |
| `TDMA_SLOT_US` | 100000 | Slot length (**µs**). 100000 = 100 ms |
| `TDMA_NUM_SLOTS` | 10 | Slots per frame (10 × 100 ms = 1 s frame) |
| `TDMA_DEVICE_SLOT` | -1 | This node’s slot **0 … N-1**; **-1** = hash from boat ID |
| `TDMA_GUARD_US` | 2000 | No TX in first/last 2 ms of each slot |
| `TDMA_ENFORCE_LORA_TX` | y | `sx1262_lora_transmit()` returns `ESP_ERR_INVALID_STATE` outside slot |
| `TDMA_ENFORCE_UWB` | y | `ryuw122_tdma_can_use_now()` returns false outside slot |

Defaults also in `sdkconfig.defaults.esp32s3`.

### Slot math

```text
slot_index = (utc_us / TDMA_SLOT_US) % TDMA_NUM_SLOTS
```

TX allowed when:

- `slot_index == tdma_device_slot()`, and
- phase within slot is between `TDMA_GUARD_US` and `TDMA_SLOT_US - TDMA_GUARD_US`

### API

```c
#include "tdma.h"

tdma_device_slot();           // this node’s slot
tdma_slot_index(utc_us);      // global slot at utc_us
tdma_can_transmit_now();      // in TX window now?
tdma_us_until_tx_window();    // µs until next window (-1 if not synced)
tdma_us_remaining_in_slot();  // µs left in current window
```

### LoRa

```c
esp_err_t err = sx1262_lora_transmit(payload, len);
// ESP_ERR_INVALID_STATE if outside TDMA slot (when enforce enabled)

// Lab / debug only:
sx1262_lora_transmit_unscheduled(payload, len);
```

### UWB (RYUW122)

Before timed UWB activity:

```c
if (ryuw122_tdma_can_use_now()) {
    // send AT / ranging in this slot
} else {
    int64_t wait = ryuw122_tdma_us_until_window();  // µs
}
```

---

## BLE / web app

NMEA lines still go to BLE characteristic **`0xFEFD`** (not printed on serial monitor).

Once per PPS (~1 Hz), firmware also sends:

```text
$PREGPPS,<esp_timer_us>,<pulse_count>[,<utc_us>]
```

- With UTC sync: **4 fields** (includes `utc_us`).
- Before sync: **2 fields** (count + esp time only).

The web app parses `$PREGPPS` for the **PPS (1 Hz)** field on the GPS tab.

---

## Boot / debug

Serial monitor (once):

```text
gps: PPS on GPIO16 → UTC timebase (1 µs) for TDMA
gps_time: UTC sync from RMC: sec=...
```

If you see `PPS disabled (GPS_PPS_GPIO=-1)` or no RMC fix, TDMA will not arm.

---

## Source file map

| File | Purpose |
| ---- | ------- |
| `main/gps_nmea.h` | UART / PPS GPIO macros |
| `main/gps_nmea.c` | UART task, PPS ISR, BLE notify |
| `main/gps_timebase.h` / `.c` | UTC µs clock |
| `main/tdma.h` / `.c` | Slot schedule |
| `main/sx1262_lora.cpp` | LoRa TX gate |
| `main/ryuw122_uart.c` | UWB TDMA helpers |

---

## Future work

- Wait-for-slot helper tasks (auto TX at slot open)
- Finer PPS capture (GPTimer hardware capture vs ISR latency)
- Explicit UWB ranging scheduled inside slot window
- BLE readout of current slot / time-to-slot for debugging
