# Freenove ESP32-S3 WROOM Lite — pinout

Reference for the **[Freenove ESP32-S3 WROOM Lite](https://store.freenove.com/products/fnk0102)** (**ESP32-S3-WROOM-1**, **8 MB flash**, octal PSRAM on GPIO35–37). Dual-row breakout; logic level **3.3 V** on all GPIO.

RegattaOne wiring (GPS, LoRa, IMU, UWB): **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** § Freenove WROOM Lite.

Build: `./scripts/idf-s3.sh freenove …`

---

## How pins are labelled on the PCB

White silkscreen beside each header hole is the **PCB label** — use that text when wiring, not abstract pin numbers.

- GPIO holes show the **number only**: `4`, `10`, `21`, … (no **`GP`**, **`GPIO`**, or **`IO`** prefix on this board).
- Power / reset / ground: **`3V3`**, **`EN`**, **`5V`**, **`GND`**.
- Console: **`TX`** and **`RX`** on the right header (these are **GPIO43** / **GPIO44** in firmware — the board does not print `43` / `44` there).

Hold the board **USB-C ports at the bottom**, module at the top. Tables list each header **top → bottom** (same order as the silkscreen down each row).

---

## Board layout

Two **USB-C** ports at the bottom. Buttons: **EN/RST** (reset), **BOOT/IO0** (download). Onboard LEDs: **TX** (GPIO43), **RX** (GPIO44), **ON** (GPIO2), **WS2812** (GPIO48).

```
        ┌─────────────────────────────────────┐
        │         ESP32-S3-WROOM-1            │
        └─────────────────────────────────────┘
              [USB-C]        [USB-C]

Left header ↓            Right header ↓
3V3                      TX
EN                       RX
4                        1
5                        2
6                        42
7                        41
15                       40
16                       39
17                       38
18                       37
8                        36
3                        35
46                       0
9                        45
10                       48
11                       47
12                       21
13                       20
14                       19
5V                       GND
```

---

## Left header (top → bottom)

| PCB label | GPIO | Extra functions | Notes |
| --------- | ---- | --------------- | ----- |
| **3V3** | — | Power | 3.3 V output |
| **EN** | — | Reset | Chip reset (button silkscreen: EN/RST) |
| **4** | 4 | ADC1_CH3, Touch4, PWM | RegattaOne: **GPS UART TX** |
| **5** | 5 | ADC1_CH4, Touch5, PWM | RegattaOne: **GPS UART RX** |
| **6** | 6 | ADC1_CH5, Touch6, PWM | Available (was LoRa BUSY on direct-SX1262 builds) |
| **7** | 7 | ADC1_CH6, Touch7, PWM | Available (was LoRa DIO1) |
| **15** | 15 | ADC2_CH4, U0RTS, PWM | RegattaOne: **Meshtastic UART RX** ← module TX |
| **16** | 16 | ADC2_CH5, U0CTS, PWM | RegattaOne: **Meshtastic UART TX** → module RX |
| **17** | 17 | ADC2_CH6, **U1TXD**, PWM | RegattaOne: **UWB UART TX** |
| **18** | 18 | ADC2_CH7, **U1RXD**, PWM | RegattaOne: **UWB UART RX** |
| **8** | 8 | ADC1_CH7, Touch8, PWM | Available (was LoRa RESET) |
| **3** | 3 | ADC1_CH2, Touch3, JTAG EN | Strapping — use with care |
| **46** | 46 | Strapping (LOG) | Avoid if possible |
| **9** | 9 | ADC1_CH8, Touch9, PWM | Available (was LoRa CS) |
| **10** | 10 | ADC1_CH9, Touch10, PWM | RegattaOne: **IMU I2C SDA** |
| **11** | 11 | ADC2_CH0, Touch11, PWM | RegattaOne: **IMU I2C SCL** |
| **12** | 12 | ADC2_CH1, Touch12, PWM | Available (was LoRa SCLK) |
| **13** | 13 | ADC2_CH2, Touch13, PWM | Available (was LoRa MOSI) |
| **14** | 14 | ADC2_CH3, Touch14, PWM | Available (was LoRa MISO) |
| **5V** | — | Power | 5 V (USB / VIN) |

---

## Right header (top → bottom)

| PCB label | GPIO | Extra functions | Notes |
| --------- | ---- | --------------- | ----- |
| **TX** | 43 | U0TXD, PWM | USB Serial/JTAG TX — **TX** LED |
| **RX** | 44 | U0RXD, PWM | USB Serial/JTAG RX — **RX** LED |
| **1** | 1 | ADC1_CH0, Touch1, PWM | Available |
| **2** | 2 | ADC1_CH1, Touch2, PWM | **ON** LED |
| **42** | 42 | JTAG MTMS, PWM | JTAG |
| **41** | 41 | JTAG MTDI, PWM | JTAG |
| **40** | 40 | JTAG MTDO, PWM | JTAG |
| **39** | 39 | JTAG MTCK, PWM | JTAG |
| **38** | 38 | PWM | Available |
| **37** | 37 | — | **Octal PSRAM** — do not use |
| **36** | 36 | — | **Octal PSRAM** — do not use |
| **35** | 35 | — | **Octal PSRAM** — do not use |
| **0** | 0 | BOOT, PWM | **BOOT** button — strapping |
| **45** | 45 | VSPI, strapping | Strapping — avoid if possible |
| **48** | 48 | PWM | Onboard **WS2812** |
| **47** | 47 | PWM | Available |
| **21** | 21 | PWM | RegattaOne: **GPS PPS** |
| **20** | 20 | USB_D−, ADC2_CH9, U1CTS | Native USB — avoid |
| **19** | 19 | USB_D+, ADC2_CH8, U1RTS | Native USB — avoid |
| **GND** | — | Ground | |

---

## RegattaOne default (`freenove` build)

LoRa is via a **companion ESP32 running Meshtastic** (UART), not a direct SX1262 on this board.

| Function | GPIO | PCB label (find on board) |
| -------- | ---- | ------------------------- |
| **IMU I2C SDA** | 10 | **10** (left) |
| **IMU I2C SCL** | 11 | **11** (left) |
| **GPS UART TX → GPS RX** | 4 | **4** (left) |
| **GPS UART RX ← GPS TX** | 5 | **5** (left) |
| **GPS PPS** | 21 | **21** (right) |
| **Meshtastic UART TX → module RX** | 16 | **16** (left) |
| **Meshtastic UART RX ← module TX** | 15 | **15** (left) |
| **DWM3000 SPI** *(optional eval)* | 6, 8, 9, 13, 14, 17, 18 | See **[WIRING-DWM3000.md](WIRING-DWM3000.md)** |

UART: **GPS = UART1**, **Meshtastic = UART2**, **console = UART0** (USB, GPIO 43/44). **UWB:** use SC16IS752 on I2C — see [WIRING-SC16IS752-I2C.md](WIRING-SC16IS752-I2C.md).

**Meshtastic companion:** enable the serial module in **PROTO** mode and match baud (default **921600** in firmware).

**Wire checklist (PCB labels):** left **4–5**, **10–11**, **15–16**, right **21**, plus **3V3** and **GND** on each module.

### Waveshare ESP32-S3-Zero companion (**GP8** / **GP9** serial)

Pair with a **Waveshare Zero** running Meshtastic. UART to Freenove (crossed TX/RX):

| Freenove | PCB label | → | Waveshare Zero | PCB label |
| -------- | --------- | - | -------------- | --------- |
| Meshtastic TX → companion RX | **16** (left) | → | GPIO **9** | **GP9** (right) |
| Meshtastic RX ← companion TX | **15** (left) | ← | GPIO **8** | **GP8** (right) |
| Ground | **GND** (right) | — | **GND** (left) | |

Meshtastic serial module: **PROTO**, **921600**, **TX = 8**, **RX = 9**.

**Note:** **GP8/GP9** are also SX1262 **RESET/CS** on the default Zero LoRa map — only works if your Meshtastic radio uses different GPIO or serial was intentionally placed here with radio remapped.

Alternative without that clash: **GP14** (TX) / **GP15** (RX) on the Zero → Freenove **15/16**.

REYAX UWB via SC16IS752 I2C (not native UART on Freenove 17/18 in current firmware defaults).

**DWM3000 (SPI UWB evaluation):** optional on GPIO **6, 8, 9, 13, 14, 17, 18** — see **[WIRING-DWM3000.md](WIRING-DWM3000.md)**.

---

## Pins to avoid

| GPIO | PCB label | Reason |
| ---- | --------- | ------ |
| **19, 20** | 19, 20 | USB D+ / D− |
| **35, 36, 37** | 35, 36, 37 | In-package octal PSRAM |
| **0, 3, 45, 46** | 0, 3, 45, 46 | Strapping / boot |
| **43, 44** | TX, RX | USB Serial/JTAG console (`idf.py monitor`) |
| **48** | 48 | Onboard WS2812 RGB LED |
| **41, 42** | 41, 42 | JTAG (unless debugging) |

---

## See also

- [WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md) — module wiring and build commands
- [TDMA-GPS-PPS.md](TDMA-GPS-PPS.md) — GPS PPS and UTC timebase
- [WAVESHARE-ESP32S3-ZERO-PINOUT.md](WAVESHARE-ESP32S3-ZERO-PINOUT.md) — Waveshare Zero silkscreen labels
