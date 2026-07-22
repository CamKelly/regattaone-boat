# Waveshare ESP32-S3-Zero — pinout

Reference for the **[Waveshare ESP32-S3-Zero](https://www.waveshare.com/wiki/ESP32-S3-Zero)** (ESP32-S3FH4R2: 4 MB flash, 2 MB PSRAM). Logic level is **3.3 V** on all GPIO.

RegattaOne wiring for GPS + LoRa on this board: **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)**.

Build: `./scripts/idf-s3.sh waveshare-zero …`

---

## How pins are labelled on the PCB

Castellated **edge** pads and **bottom** pads have white silkscreen beside each hole. That text is the **PCB label**:

- GPIO pads are prefixed **`GP`** + number (`GP4`, `GP13`, …) — same as SoC GPIO.
- Power: **`5V`**, **`GND`**, **`3V3(OUT)`** (may read as **3V3** on some boards).
- Console: **`TX`** = GPIO **43**, **`RX`** = GPIO **44** (USB Serial/JTAG).
- Underside pads use the same **`GP*n*** style.

Pins are listed **from the USB-C end downward** on each edge (top → bottom in the diagram).

---

## Board layout (USB-C at top)

```
                    ┌─── USB-C ───┐
                    │  [B]  [R]   │
                    └─────────────┘

Left edge ↓              Right edge ↓
5V                       TX
GND                      RX
3V3(OUT)                 GP13
GP1                      GP12
GP2                      GP11
GP3                      GP10
GP4                      GP9
GP5                      GP8
GP6                      GP7
                         GP16
                         GP15
                         GP14

Bottom pads (underside): GP45  GP42  GP41  GP40  GP39  GP38  GP18  GP17
```

---

## Power (left edge)

| PCB label | GPIO | Description |
| --------- | ---- | ----------- |
| **5V** | — | 5 V from USB |
| **GND** | — | Ground |
| **3V3(OUT)** | — | 3.3 V output for peripherals |

Use **3V3(OUT) + GND** for GPS and LoRa modules unless the module datasheet requires 5 V.

---

## Left edge (top → bottom)

| PCB label | GPIO | Alternate functions (ESP32-S3) |
| --------- | ---- | ------------------------------ |
| **5V** | — | Power |
| **GND** | — | Ground |
| **3V3(OUT)** | — | Power |
| **GP1** | 1 | UART, PWM, I2S, ADC, I2C, SPI |
| **GP2** | 2 | UART, PWM, I2S, ADC, I2C, SPI |
| **GP3** | 3 | UART, PWM, I2S, ADC, I2C, SPI |
| **GP4** | 4 | UART, PWM, I2S, ADC, I2C, SPI — RegattaOne **GPS TX** |
| **GP5** | 5 | UART, PWM, I2S, ADC, I2C, SPI — RegattaOne **GPS RX** |
| **GP6** | 6 | UART, PWM, I2S, ADC, I2C, SPI — RegattaOne **LoRa BUSY** |

---

## Right edge (top → bottom)

| PCB label | GPIO | Alternate functions |
| --------- | ---- | ------------------- |
| **TX** | **43** | USB Serial/JTAG TX (console) |
| **RX** | **44** | USB Serial/JTAG RX (console) |
| **GP13** | 13 | SPI, I2C, ADC, I2S, PWM, UART — RegattaOne **LoRa MOSI** |
| **GP12** | 12 | SPI, I2C, ADC, I2S, PWM, UART — RegattaOne **LoRa SCLK** |
| **GP11** | 11 | SPI, I2C, ADC, I2S, PWM, UART |
| **GP10** | 10 | SPI, I2C, ADC, I2S, PWM, UART — RegattaOne **LoRa MISO** |
| **GP9** | 9 | SPI, I2C, ADC, I2S, PWM, UART — RegattaOne **LoRa CS** |
| **GP8** | 8 | SPI, I2C, ADC, I2S, PWM, UART — RegattaOne **LoRa RESET** |
| **GP7** | 7 | SPI, I2C, ADC, I2S, PWM, UART — RegattaOne **LoRa DIO1** |
| **GP16** | 16 | SPI, I2C, ADC, I2S, PWM, UART — optional **GPS PPS** |
| **GP15** | 15 | SPI, I2C, ADC, I2S, PWM, UART |
| **GP14** | 14 | SPI, I2C, ADC, I2S, PWM, UART |

---

## Bottom pads (underside, left → right)

| PCB label | GPIO | Alternate functions | Notes |
| --------- | ---- | ----------------- | ----- |
| **GP45** | 45 | UART, PWM, I2S, I2C, SPI | Strapping — avoid if possible |
| **GP42** | 42 | UART, PWM, I2S, I2C, SPI | |
| **GP41** | 41 | UART, PWM, I2S, I2C, SPI | |
| **GP40** | 40 | UART, PWM, I2S, I2C, SPI | |
| **GP39** | 39 | UART, PWM, I2S, I2C, SPI | |
| **GP38** | 38 | UART, PWM, I2S, I2C, SPI | |
| **GP18** | 18 | UART, PWM, I2S, ADC, I2C, SPI | Unused on default Zero plan (available) |
| **GP17** | 17 | UART, PWM, I2S, ADC, I2C, SPI | Unused on default Zero plan (available) |

**GP33–GP37** are not broken out on this board.

---

## Onboard (not on edge)

| Resource | GPIO | Notes |
| -------- | ---- | ----- |
| **WS2812 RGB LED** | **21** | Not on castellated edge — do not use for GPS PPS |

---

## RegattaOne default (`waveshare-zero` build)

Default firmware uses **edge pads GP4–GP13** for GPS + LoRa only. IMU and UWB are disabled in `sdkconfig.defaults.esp32s3.board-waveshare-zero`.

| Function | GPIO | PCB label (find on board) |
| -------- | ---- | ------------------------- |
| GPS UART TX → GPS RX | **4** | **GP4** (left) |
| GPS UART RX ← GPS TX | **5** | **GP5** (left) |
| LoRa BUSY | **6** | **GP6** (left) |
| LoRa DIO1 | **7** | **GP7** (right) |
| LoRa RESET | **8** | **GP8** (right) |
| LoRa CS | **9** | **GP9** (right) |
| LoRa MISO | **10** | **GP10** (right) |
| LoRa SCLK | **12** | **GP12** (right) |
| LoRa MOSI | **13** | **GP13** (right) |
| GPS PPS | **-1** (off) | **GP16** (right) optional — set `GPS_PPS_GPIO=16` in menuconfig |

**Solder checklist (PCB labels):** left **GP4–GP6**, right **GP7–GP10**, **GP12–GP13**, plus **3V3(OUT)** and **GND** on each module.

---

## Meshtastic companion → Freenove WROOM Lite

When this Zero runs **Meshtastic** (not RegattaOne firmware) and talks to a **Freenove** main board over UART.

### In use: **GP8** (TX) + **GP9** (RX)

| Waveshare (Meshtastic serial) | GPIO | PCB label | Wire to Freenove |
| ----------------------------- | ---- | --------- | ---------------- |
| Serial **TX** → Freenove RX | **8** | **GP8** (right) | **15** (left) |
| Serial **RX** ← Freenove TX | **9** | **GP9** (right) | **16** (left) |
| **GND** | — | **GND** (left) | **GND** (right) |

**Meshtastic device settings** (Serial module): mode **PROTO**, baud **921600**, **TX = GPIO 8**, **RX = GPIO 9**.

**Conflict:** On this board **GP8** / **GP9** are also the default **SX1262 RESET** / **CS** (RegattaOne `waveshare-zero` map). If your LoRa module is wired to those pads, serial and radio cannot share them — either move serial to **GP14/GP15** or remap the radio in Meshtastic.

Do **not** use **TX/RX** silkscreen on the Zero (GPIO **43/44**) — that is the USB console.

### Alternative (no LoRa pin clash): **GP14** / **GP15**

| Serial **TX** | **14** | **GP14** | → Freenove **15** |
| Serial **RX** | **15** | **GP15** | ← Freenove **16** |

Meshtastic serial: **TX = 14**, **RX = 15**.

---

## Pins to avoid or use with care

| GPIO | PCB label | Reason |
| ---- | --------- | ------ |
| **19, 20** | — | USB D− / D+ (not on edge) |
| **26–32** | — | In-package flash / PSRAM |
| **0, 3, 45, 46** | **GP45** (bottom) | Strapping |
| **43, 44** | **RX**, **TX** | USB Serial/JTAG console |
| **21** | — | Onboard WS2812 |

On the **default Zero plan**, these pads are **not assigned** in firmware: **GP1–GP3**, **GP11**, **GP14–GP15**, bottom **GP17–GP18**, **GP38–GP42**, **GP45**. Enable IMU, UWB, or extra GPIO only after updating **menuconfig** and the wiring doc.

---

## See also

- [WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md) — full schematic-style tables and build commands
- [TDMA-GPS-PPS.md](TDMA-GPS-PPS.md) — GPS PPS and UTC timebase (optional on **GP16**)
- [FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md](FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md) — Freenove silkscreen labels
