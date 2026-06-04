# Wiring: ESP32-S3 ↔ SX1262 LoRa ↔ GPS ↔ REYAX RYUW122 ↔ SEN0140 IMU

This document describes pin plans for **two ESP32-S3 carriers** supported by firmware:

| Board | Module | Select in build |
| ----- | ------ | ---------------- |
| **ESP32-S3-DevKitM-1** / WEMOS LOLIN Mini | **ESP32-S3-MINI-1** | `scripts/idf-s3.sh devkit-mini …` |
| **Waveshare ESP32-S3-Zero** | **ESP32-S3FH4R2** (4 MB flash, 2 MB PSRAM) | `scripts/idf-s3.sh waveshare-zero …` |

The Blues **Notecard** is replaced by an **SX1262** LoRa module over **SPI** (RadioLib). **GPS** uses **NMEA 0183** on UART plus **PPS**. **REYAX RYUW122** UWB stays on UART. **SEN0140** IMU stays on I2C.

**Logic level:** 3.3 V only on all module I/O.

---

## Choosing a board at build time

**Recommended** — helper script sets `SDKCONFIG_DEFAULTS` and runs `idf.py`:

```bash
# First time (or after switching boards — delete sdkconfig first):
rm -f sdkconfig
./scripts/idf-s3.sh devkit-mini set-target esp32s3
./scripts/idf-s3.sh devkit-mini build flash monitor

# Waveshare ESP32-S3-Zero:
rm -f sdkconfig
./scripts/idf-s3.sh waveshare-zero set-target esp32s3
./scripts/idf-s3.sh waveshare-zero build flash monitor
```

**Alternative** — `idf.py menuconfig` → **Component config → RegattaOne — ESP32-S3 board**, then adjust pins under the other RegattaOne menus.

When switching boards, delete **`sdkconfig`** (or run `idf.py fullclean`) so stale GPIO values are not kept.

---

## Pin summary — DevKit Mini (default)

| Function | Signal | SoC GPIO | Header (typical) | Notes |
| -------- | ------ | -------- | ---------------- | ----- |
| **IMU I2C** | SDA | **10** | IO10 | SEN0140 |
| | SCL | **11** | IO11 | |
| **LoRa SPI** | MOSI (SDI) | **13** | IO13 | SX1262 |
| | MISO (SDO) | **14** | IO14 | |
| | SCLK (SCK) | **12** | IO12 | SPI2 / FSPI |
| | CS / NSS | **9** | IO9 | |
| | RESET | **8** | IO8 | Active-low reset |
| | DIO1 (IRQ) | **7** | IO7 | RadioLib interrupt |
| | BUSY | **6** | IO6 | Required for SX1262 |
| **GPS UART** | ESP TX → GPS RX | **4** | IO4 | UART2 |
| | ESP RX ← GPS TX | **5** | IO5 | NMEA 0183 |
| **GPS PPS** | 1 Hz pulse in | **21** | IO21 | Optional; `-1` if unwired |
| **UWB UART** | ESP TX → module RX | **17** | IO17 | UART1, RYUW122 |
| | ESP RX ← module TX | **18** | IO18 | |

---

## Pin summary — Waveshare ESP32-S3-Zero

Right-edge **GP12–GP14 / GP9–GP7 / GP10–GP11** match the DevKit Mini LoRa + IMU cluster. Left-edge **GP4 / GP5** suit GPS UART. **GP17 / GP18** are bottom pads for UWB.

| Function | Signal | SoC GPIO | Zero label | Notes |
| -------- | ------ | -------- | ---------- | ----- |
| **IMU I2C** | SDA | **10** | GP10 | Right edge |
| | SCL | **11** | GP11 | |
| **LoRa SPI** | MOSI | **13** | GP13 | Same as DevKit Mini |
| | MISO | **14** | GP14 | |
| | SCLK | **12** | GP12 | SPI2 / FSPI |
| | CS | **9** | GP9 | |
| | RESET | **8** | GP8 | |
| | DIO1 | **7** | GP7 | |
| | BUSY | **6** | GP6 | |
| **GPS UART** | ESP TX → GPS RX | **4** | GP4 | Left edge |
| | ESP RX ← GPS TX | **5** | GP5 | UART2 |
| **GPS PPS** | 1 Hz pulse in | **16** | GP16 | **Not GP21** — onboard WS2812 RGB |
| **UWB UART** | ESP TX → module RX | **17** | GP17 | Bottom pad |
| | ESP RX ← module TX | **18** | GP18 | Bottom pad |

**Zero-specific:** **GP21** drives the onboard **WS2812** LED — do not use for PPS or peripherals. **GP45** is a strapping pin (bottom pad). **TX/RX** silkscreen pins are UART0 / USB-serial — leave for console.

---

## SX1262 LoRa (SPI)

Typical module (Ebyte E22, Waveshare SX1262, etc.):

| SX1262 pin | ESP32-S3 Mini | GPIO |
| ---------- | ------------- | ---- |
| **VCC** | 3.3 V | — |
| **GND** | GND | — |
| **MOSI / SDI** | IO13 | 13 |
| **MISO / SDO** | IO14 | 14 |
| **SCK** | IO12 | 12 |
| **NSS / CS** | IO9 | 9 |
| **RESET** | IO8 | 8 |
| **DIO1** | IO7 | 7 |
| **BUSY** | IO6 | 6 |

SPI host: **SPI2 (FSPI)** at **2 MHz** by default (`SX1262_SPI_FREQ_HZ`). Center frequency default **915 MHz** (`SX1262_FREQ_HZ`); change for your region/module.

Firmware uses **[RadioLib](https://github.com/jgromes/RadioLib)** vendored in `components/RadioLib/`. `main/sx1262_lora.cpp` initializes the SX1262 and runs a background RX task (logs received packets to serial). Pin macros: `main/sx1262_lora.h`.

---

## GPS (NMEA 0183 + PPS)

| GPS pin | ESP32-S3 Mini | GPIO |
| ------- | --------------- | ---- |
| **VCC** | 3.3 V (or module spec) | — |
| **GND** | GND | — |
| **RX** ← ESP TX | IO4 | 4 |
| **TX** → ESP RX | IO5 | 5 |
| **PPS** (if present) | IO21 | 21 |

- UART: **UART2** (`GPS_UART_PORT_NUM=2`) so **UART1** remains free for RYUW122.
- Baud: **9600** default (common NMEA rate). Many modules ship at **115200** — match `GPS_UART_BAUD` to your module or reconfigure the GPS.
- **PPS:** rising edge ~1 Hz when locked. Firmware counts pulses on the configured GPIO and sends `$PREGPPS,<us>,<count>` on the same BLE GPS characteristic (0xFEFD). NMEA sentences are **not** printed to the serial monitor.

Pin macros: `main/gps_nmea.h`. Set `GPS_PPS_GPIO=-1` in menuconfig if unwired.

---

## REYAX RYUW122 Lite (UWB UART)

Unchanged from the prior design — still **UART1** on GPIO **17/18**:

| RYUW122 pin | ESP32-S3 Mini | GPIO |
| ----------- | ------------- | ---- |
| **VCC** | 3.3 V | — |
| **GND** | GND | — |
| **RX** ← ESP TX | IO17 | 17 |
| **TX** → ESP RX | IO18 | 18 |

Cross-connect TX/RX. Boot probe tries **115200 / 9600 / 57600** (see `ryuw122_uart.c`).

---

## SEN0140 10-DOF IMU (I2C)

Same as [WIRING-SEN0140.md](WIRING-SEN0140.md) — **GPIO10 SDA**, **GPIO11 SCL**. No shared bus with LoRa (SPI) or UART peripherals.

---

## GPIOs to avoid on ESP32-S3

| GPIO | Reason |
| ---- | ------ |
| **19, 20** | USB D− / D+ (native USB) |
| **26–32** | In-package flash / PSRAM (do not use as GPIO) |
| **0, 3, 45, 46** | Strapping — avoid if possible (GP45 exposed on Zero bottom) |
| **43, 44** | USB Serial/JTAG (console; Zero **TX/RX** header) |
| **21** | Waveshare Zero onboard **WS2812** — use GP16 for GPS PPS instead |

---

## Build

```bash
# DevKit Mini (ESP32-S3-MINI-1 carrier):
./scripts/idf-s3.sh devkit-mini set-target esp32s3
./scripts/idf-s3.sh devkit-mini build flash monitor

# Waveshare ESP32-S3-Zero:
./scripts/idf-s3.sh waveshare-zero set-target esp32s3
./scripts/idf-s3.sh waveshare-zero build flash monitor
```

After changing pins, run **`idf.py menuconfig`** → **RegattaOne** and rebuild.

---

## Legacy: Blues Notecard (ESP32-C3)

The previous **Notecard over I2C** wiring for Seeed XIAO ESP32-C3 is unchanged in [WIRING-ESP32C3-NOTECARD-UWB.md](WIRING-ESP32C3-NOTECARD-UWB.md). On ESP32-S3 Mini, **`CONFIG_REGATTAONE_NOTECARD_ENABLE=n`** — use SX1262 instead.
