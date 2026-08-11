# Wiring: Qorvo DWM3000 ↔ ESP32-S3 (Freenove WROOM Lite)

Module pinout reference: **[dwm3000.webp](dwm3000.webp)** (24-pin DWM3000, integrated UWB antenna).

Firmware driver: vendored [br101/dw3000-decadriver-source](../components/dw3000-decadriver-source/) (`decadriver` ESP-IDF component). Enable **`REGATTAONE_DW3000_ENABLE`** in menuconfig and set pins under **Decadriver**.

**Logic level:** 3.3 V only. Do not connect 5 V to module I/O.

This is the RegattaOne **UWB** path (SPI two-way ranging via libdeca / decadriver).

---

## DWM3000 module pins (from pinout diagram)

| Pin | Name | Role |
| --- | ---- | ---- |
| 1 | EXTON | External LDO enable — tie **3.3 V** for normal use |
| 2 | WAKEUP | Wake from sleep (optional ESP GPIO) |
| 3 | RSTn | Active-low reset |
| 4 | GPIO7 | General-purpose (not used in default RegattaOne map) |
| 5 | VDD1 | 3.3 V supply |
| 6–7 | VDD3V3 | 3.3 V supply |
| 8 | VSS | GND |
| 9–15 | GPIO6 … GPIO0 | General-purpose |
| 16 | VSS | GND |
| 17 | SPICSn | SPI chip select (active low) |
| 18 | SPIMOSI | SPI MOSI (into module) |
| 19 | SPIMISO | SPI MISO (out of module) |
| 20 | SPICLK | SPI clock |
| 21 | VSS | GND |
| 22 | GPIO8 / **IRQ** | Interrupt to host (default IRQ line) |
| 23–24 | VSS | GND |

**IRQ:** On DWM3000, pin **22** is **GPIO8** configured as **IRQ** by default (active high). A **100 kΩ** pull-down to GND on IRQ is recommended if you see spurious interrupts in sleep modes (Qorvo datasheet).

---

## Freenove ESP32-S3 WROOM Lite — recommended map

Uses GPIOs that were reserved for direct SX1262 LoRa but are **free** on the Freenove build (LoRa via Meshtastic UART).

| DWM3000 pin | DWM3000 signal | → | ESP32-S3 | Freenove PCB label | menuconfig (`Decadriver`) |
| ----------- | -------------- | - | -------- | ------------------ | ------------------------- |
| 5, 6, 7 | VDD1 / VDD3V3 | → | **3V3** | **3V3** (left) | — |
| 1 | EXTON | → | **3V3** | **3V3** (left) | — |
| 8, 16, 21, 23, 24 | VSS | → | **GND** | **GND** (right) | — |
| 18 | SPIMOSI | ↔ | **GPIO 13** | **13** (left) | `DW3000_SPI_MOSI` |
| 19 | SPIMISO | ↔ | **GPIO 14** | **14** (left) | `DW3000_SPI_MISO` |
| 20 | SPICLK | ↔ | **GPIO 9** | **9** (left) | `DW3000_SPI_CLK` |
| 17 | SPICSn | ↔ | **GPIO 8** | **8** (left) | `DW3000_SPI_CS` |
| 3 | RSTn | ↔ | **GPIO 6** | **6** (left) | `DW3000_GPIO_RESET` |
| 2 | WAKEUP | ↔ | **GPIO 17** | **17** (left) | `DW3000_GPIO_WAKEUP` |
| 22 | IRQ (GPIO8) | → | **GPIO 18** | **18** (left) | `DW3000_GPIO_IRQ` |

**Cross-connect SPI:** ESP MOSI → module MOSI (pin 18), ESP MISO ← module MISO (pin 19), ESP CLK → module CLK (pin 20), ESP CS → module CS (pin 17).

### Pins already used on Freenove (do not reuse)

| GPIO | PCB label | Function |
| ---- | --------- | -------- |
| 4, 5 | 4, 5 | GPS UART |
| 10, 11 | 10, 11 | IMU I2C |
| 15, 16 | 15, 16 | Meshtastic UART |
| 21 | 21 | GPS PPS |
| 43, 44 | TX, RX | USB console |

GPIO **7** and **12** are free on the current Freenove map (not used by GPS, Meshtastic, IMU, or DWM3000).

See **[FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md](FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md)**.

---

## Wiring sketch

```
Freenove ESP32-S3                    DWM3000 (pin numbers)
─────────────────                    ─────────────────────
3V3  ─────────────────────────────  1 EXTON, 5 VDD1, 6–7 VDD3V3
GND  ─────────────────────────────  8, 16, 21, 23, 24 VSS

GPIO 13 (MOSI) ────────────────────  18 SPIMOSI
GPIO 14 (MISO) ────────────────────  19 SPIMISO
GPIO 9  (CLK)  ────────────────────  20 SPICLK
GPIO 8  (CS)   ────────────────────  17 SPICSn
GPIO 6  (RST)  ────────────────────  3 RSTn
GPIO 17 (WAKE) ────────────────────  2 WAKEUP
GPIO 18 (IRQ)  ────────────────────  22 IRQ / GPIO8
```

Keep leads short; SPI at 2 MHz during init (driver default), up to ~22 MHz in menuconfig (`DW3000_SPI_MAX_MHZ`).

---

## Firmware bring-up

1. Wire per table above.
2. `idf.py menuconfig`:
   - **RegattaOne — DWM3000** → enable evaluation
   - **Enable UWB two-way ranging (libdeca TWR)** — for distance measurement (not just DEVID probe)
   - Set **This device's 16-bit UWB address** (unique per board; other devices use this as the ranging target id)
   - Set **UWB PAN id** the same on every device (default `0xDECA`)
   - **TWR processing delay** must match on all ranging peers (default 8000 µs; increase if you see TX timing errors)
   - **Decadriver** → confirm GPIOs (pre-filled in Freenove `sdkconfig.defaults`)
   - **Select Chip** → **DW3000** (DW3110 / DW3120 on DWM3000)
3. Build and flash (`./scripts/idf-s3.sh freenove build flash monitor`).
4. With ranging **disabled**, expect serial log:
   ```
   dw3000_probe: DEVID 0xdeca0302
   ```
   With ranging **enabled**, expect:
   ```
   dw3000_rng: ready: addr 0x0001, pan 0xdeca, ant 16368, proc 8000 us
   ```

If DEVID is wrong: check 3.3 V, GND, CS/RST/IRQ wiring, and that SPI CLK is on **GPIO 9** (not GPIO 12).

---

## Two-way ranging (distance to another device)

Vendored [libdeca](https://github.com/br101/libdeca) (`components/libdeca/`) provides DS-TWR on top of the decadriver. RegattaOne wraps it in `main/dw3000_ranging.h`.

### Setup (two or more boards)

| Setting | Device A | Device B |
| ------- | -------- | -------- |
| `DW3000_ADDR` | `0x0001` | `0x0002` |
| `DW3000_PANID` | `0xDECA` | `0xDECA` (same) |
| `DW3000_TWR_PROCESSING_DELAY_US` | `8000` | `8000` (same) |

Each device automatically listens for ranging requests. No separate “anchor” mode is required.

### API (firmware)

```c
#include "dw3000_ranging.h"

// After boot (app_main calls dw3000_ranging_init when ranging is enabled):
uint16_t cm;
esp_err_t err = dw3000_range_to(0x0002, &cm, 120);  // measure distance to device 0x0002
if (err == ESP_OK) {
    ESP_LOGI("app", "peer 0x0002 is %u cm away", cm);
}

// Optional async callback for every completed range (initiated locally or by a peer):
dw3000_ranging_set_callback(my_range_cb);
```

- `dw3000_range_to(peer_addr, &dist_cm, timeout_ms)` — blocking; returns distance in **centimetres**
- `dw3000_ranging_self_addr()` — this device's UWB address (`DW3000_ADDR`)
- Only one `dw3000_range_to()` at a time per device

### Bench test

1. Flash two boards with different `DW3000_ADDR` values.
2. On device A, add a periodic call to `dw3000_range_to(0x0002, &cm, 120)` (or use the serial log from a temporary test hook).
3. Move boards apart; logged distance should track separation (UWB line-of-sight, ~10 cm–200 m depending on environment).

Antenna delay (`DW3000_ANTENNA_DELAY`) affects absolute accuracy; calibrate against a known distance if you need cm-level precision.

---

## See also

- [components/libdeca/VENDOR.md](../components/libdeca/VENDOR.md) — vendored libdeca notes

- [FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md](FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md)
- [WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md) — GPS / LoRa / IMU pin plans
- [components/dw3000-decadriver-source/VENDOR.md](../components/dw3000-decadriver-source/VENDOR.md) — vendored driver notes
