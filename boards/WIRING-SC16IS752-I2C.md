# Wiring: SC16IS752 (CJMCU-752) ↔ ESP32-S3 over I²C

This document describes how to wire and configure the **CJMCU-752** dual-UART breakout (**SC16IS752** I²C/SPI → two UART channels) for use with an **ESP32-S3** over **I²C**.

Typical use in this project: drive **two REYAX RYUW122** UWB modules from one ESP32 I²C bus, freeing native ESP32 UARTs for GPS, Meshtastic, or other peripherals.

**Logic level:** 3.3 V only on all module I/O.

---

## Board overview

The CJMCU-752 supports **both I²C and SPI** without solder jumpers. The active interface is selected by the **`I2C/SPI`** pin:

| `I2C/SPI` pin | Mode |
| ------------- | ---- |
| **HIGH (3.3 V)** | **I²C** |
| **LOW (GND)** | SPI |

Pin labels are shared between modes:

| Silkscreen label | I²C function | SPI function |
| ---------------- | ------------ | ------------ |
| **SDA/VSS** | SDA | — |
| **SCL/SCLK** | SCL | SCLK |
| **A0/CS** | Address bit **A0** | Chip select |
| **A1/SI** | Address bit **A1** | MOSI |
| **NC/SO** | *(unused)* | MISO |

---

## Power

| ESP32-S3 | CJMCU-752 | Notes |
| -------- | --------- | ----- |
| **3.3 V** | **VCC** | Use **3.3 V**, not 5 V |
| **GND** | **GND** | Common ground |

---

## I²C bus

| ESP32-S3 | CJMCU-752 | Notes |
| -------- | --------- | ----- |
| **SDA** (e.g. GPIO8) | **SDA/VSS** | Shared label with SPI |
| **SCL** (e.g. GPIO9) | **SCL/SCLK** | Shared label with SPI |

**GPIO numbers are examples.** Pick SDA/SCL pins that are free on your carrier board and do not conflict with flash straps, USB, or other peripherals. See **[FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md](FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md)** or **[WAVESHARE-ESP32S3-ZERO-PINOUT.md](WAVESHARE-ESP32S3-ZERO-PINOUT.md)** before committing to GPIO8/GPIO9.

### I²C pull-ups

The CJMCU-752 may **not** include dedicated pull-ups on **SDA** and **SCL**. The resistor array on the board is often tied to GPIO/UART lines, not the I²C bus.

If your ESP32 board does not already pull up SDA/SCL, add external resistors:

```
3.3 V
  |
 4.7 kΩ
  |
 SDA

3.3 V
  |
 4.7 kΩ
  |
 SCL
```

Many ESP32 dev boards already include I²C pull-ups — verify yours before adding extras.

---

## Interface select and I²C address

### Interface select

| CJMCU-752 pin | Connect to | Result |
| ------------- | ---------- | ------ |
| **I2C/SPI** | **3.3 V** | **I²C mode** |

### Address pins (A0, A1)

In I²C mode:

| CJMCU-752 pin | I²C role |
| ------------- | -------- |
| **A0/CS** | Address bit **A0** |
| **A1/SI** | Address bit **A1** |

For a **single** board on the bus with **A0/A1 tied only to 3V3 or GND** (typical CJMCU wiring):

| A1 | A0 | 7-bit address |
| -- | -- | ------------- |
| 3V3 | 3V3 | **0x48** |
| 3V3 | GND | **0x49** |
| GND | 3V3 | **0x4C** |
| GND | GND | **0x4D** |

**Common mistake:** both **A0** and **A1** to **GND** is **0x4D**, not 0x48. Our Freenove Option A doc uses both GND → set firmware to **0x4D**.

The chip can also use **SCL** or **SDA** as strap levels (16 addresses total); see the NXP SC16IS752 datasheet Table 32 if you strap to bus lines.

Legacy shorthand (A1/A0 as binary 0–3 → 0x48–0x4B) appears in some summaries — **CJMCU-752 boards follow the VDD/VSS table above**, not 0x48 for “both low”.

### Unused in I²C mode

| Pin | Action |
| --- | ------ |
| **NC/SO** | Leave **disconnected** (SPI MISO in SPI mode) |

---

## Interrupt and reset

### IRQ (recommended)

Connect **IRQ** to a free ESP32 GPIO so the SC16IS752 can interrupt when either UART receives data.

| ESP32-S3 | CJMCU-752 |
| -------- | --------- |
| **GPIO4** (or any free GPIO) | **IRQ** |

Use **active-low** interrupt handling in firmware (verify against the SC16IS752 datasheet for your register setup).

### RESET

| Option | Wiring | Notes |
| ------ | ------ | ----- |
| **Simple** | **RESET → 3.3 V** | Always out of reset |
| **Recommended** | **RESET → ESP32 GPIO** (e.g. GPIO5) | Software reset recovery after I²C bus lockups |

---

## UART channels → RYUW122 modules

Cross-connect each UART (ESP/device TX → module RX, device RX ← module TX). **115200 baud** is standard for RYUW122 in this project.

### UART A (channel A)

| CJMCU-752 | RYUW122 #1 (Anchor) |
| --------- | --------------------- |
| **TXA** | **RX** |
| **RXA** | **TX** |

### UART B (channel B)

| CJMCU-752 | RYUW122 #2 (Tag) |
| --------- | ---------------- |
| **TXB** | **RX** |
| **RXB** | **TX** |

**RTS/CTS** are not required unless you enable hardware flow control in software.

Each RYUW122 also needs **3.3 V**, **GND**, and (optionally) a **RESET** GPIO — see **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** for RYUW122 power and UART conventions.

---

## Bonus GPIO (GP0–GP7)

The SC16IS752 exposes eight general-purpose pins:

```
GP0, GP1, GP2, GP3, GP4, GP5, GP6, GP7
```

Optional uses:

- Module **RESET** lines
- **LEDs**
- Extra **interrupt inputs**
- **Chip enable** lines

Leave unused if not needed.

---

## Freenove ESP32-S3 WROOM Lite (RegattaOne `freenove` build)

GPS (**4/5**), Meshtastic (**15/16**), and IMU I2C (**10/11**) are already assigned. **Do not** use GPIO **4** or **5** for SC16IS752 IRQ/RESET.

### Option A — shared I2C with IMU (fewest wires)

Wire SC16IS752 **SDA/SCL** to the same pins as the SEN0140 bus. Address **0x48** does not conflict with IMU sensor addresses.

| CJMCU-752 pin (right header) | Freenove PCB label | GPIO |
| ---------------------------- | ------------------ | ---- |
| **VCC** | **3V3** (left) | — |
| **GND** | **GND** (right) | — |
| **SDA/VSS** | **10** (left) | **10** |
| **SCL/SCLK** | **11** (left) | **11** |
| **I2C/SPI** | **3V3** (left) | I²C mode |
| **A0/CS** | **GND** | address **0x4D** |
| **A1/SI** | **GND** | address **0x4D** |
| **NC/SO** | *(no wire)* | — |
| **IRQ** | **7** (left) | **7** |
| **RESET** | **12** (left) | **12** *(optional)* |

### Option B — separate I2C bus (doc default)

Use if you want SC16IS752 off the IMU bus, or IMU is not wired.

| CJMCU-752 pin | Freenove PCB label | GPIO |
| ------------- | ------------------ | ---- |
| **SDA/VSS** | **8** (left) | **8** |
| **SCL/SCLK** | **9** (left) | **9** |
| *(power, I2C/SPI, A0, A1, NC/SO same as Option A)* | | |
| **IRQ** | **7** (left) | **7** |
| **RESET** | **12** (left) | **12** |

Add **4.7 kΩ** pull-ups on SDA and SCL to **3.3 V** if the bus has none (Freenove may already pull up **10/11**; **8/9** often need externals).

### UART side (RYUW122 — when you wire UWB later)

| CJMCU-752 (left header) | RYUW122 |
| ----------------------- | ------- |
| **TXA** → module **RX** | Anchor #1 |
| **RXA** ← module **TX** | |
| **TXB** → module **RX** | Tag #2 |
| **RXB** ← module **TX** | |

Leave **RTSA/CTSA/RTSB/CTSB** unwired unless using hardware flow control.

```
Freenove (Option B)                 CJMCU-752
----------------                    -----------
3V3 (left)  ----------------------  VCC
GND         ----------------------  GND
8 (left)    ----------------------  SDA/VSS
9 (left)    ----------------------  SCL/SCLK
7 (left)    ----------------------  IRQ
12 (left)   ----------------------  RESET (optional)
3V3         ----------------------  I2C/SPI
GND         ----------------------  A0/CS, A1/SI
```

Pinout reference: **[FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md](FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md)**

---

Example pin plan (adjust GPIO numbers for your board):

| ESP32-S3 | CJMCU-752 / function |
| -------- | -------------------- |
| **3.3 V** | **VCC** |
| **GND** | **GND** |
| **GPIO8** (SDA) | **SDA/VSS** |
| **GPIO9** (SCL) | **SCL/SCLK** |
| **GPIO4** | **IRQ** |
| **GPIO5** | **RESET** *(optional)* |
| **3.3 V** | **I2C/SPI** *(select I²C)* |
| **GND** | **A0/CS** |
| **GND** | **A1/SI** *(address 0x48)* |
| — | **NC/SO** *(no connect)* |
| **TXA / RXA** | RYUW122 **#1** (Anchor) |
| **TXB / RXB** | RYUW122 **#2** (Tag) |

```
ESP32-S3                          CJMCU-752 (SC16IS752)
------------------------          -----------------------
3.3 V  -------------------------- VCC
GND    -------------------------- GND
GPIO8  -------------------------- SDA/VSS
GPIO9  -------------------------- SCL/SCLK
GPIO4  -------------------------- IRQ
GPIO5  -------------------------- RESET (optional)
3.3 V  -------------------------- I2C/SPI  (I²C mode)
GND    -------------------------- A0/CS     (A0 = 0)
GND    -------------------------- A1/SI     (A1 = 0)

TXA  ---------------------------> RYUW122 #1 RX
RXA  <--------------------------- RYUW122 #1 TX

TXB  ---------------------------> RYUW122 #2 RX
RXB  <--------------------------- RYUW122 #2 TX
```

---

## Crystal frequency (critical for baud rate)

The CJMCU-752 uses an **external crystal** (metal can on the back of the board). The frequency is often **not marked** on the silkscreen — **measure or identify yours before writing the driver**.

### This board: **1.8432 MHz**

**Use `1843200` Hz** (1.8432 MHz) in all SC16IS752 clock / baud-rate register setup. Do **not** assume 14.7456 MHz; that is a different CJMCU-752 variant and will produce wrong UART timing.

1.8432 MHz is a valid SC16IS752 crystal (÷8 relationship to 14.7456 MHz). Standard baud rates such as **115200** still work when the driver uses the correct frequency in the divisor calculation.

| Crystal | When you see it | Driver constant |
| ------- | ----------------- | --------------- |
| **1.8432 MHz** | **This board** | **`1843200`** |
| **14.7456 MHz** | Other CJMCU-752 boards | `14745600` |

If UART output is garbage but I²C communication works, **wrong crystal frequency in software** is the first thing to check.

---

## Driver / firmware checklist

Firmware in this repo (`main/sc16is752.c`, `main/ryuw122_uart.c`):

1. **menuconfig:** `RegattaOne — SC16IS752` → enable bridge; Freenove defaults share IMU I2C (GPIO **10/11**), IRQ **7**, RESET **12**, crystal **1843200**.
2. **menuconfig:** `RegattaOne — REYAX RYUW122` → enable listener → BLE **0xFEF9** (uses SC16IS752 channel A when bridge is on).
3. Boot log should show `I2C probe 0x48 → ESP_OK` and `sc16is752: ready @ I2C 0x48 crystal=1843200 Hz`.
4. **Pulse RESET** on GPIO **12** during boot (or tie RESET to 3V3).
5. **Configure IRQ** GPIO **7**; RX interrupts enabled on the UWB channel.
6. **Crystal `1843200`** (1.8432 MHz) — required for this board.
7. **115200 8N1** on channel A (and B when enabled).
8. **Service IRQ** in the `ryuw122` task: drain RX FIFO → line parser → BLE **0xFEF9**; AT writes on **0xFEFA** go to channel A TX.

Related project docs:

- **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** — single RYUW122 on native ESP32 UART
- **`main/ryuw122_uart.c`** — current single-channel UART listener (reference for line parsing and BLE notify)

---

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| I²C NACK / no device at 0x48 | Wrong address straps; **I2C/SPI** not tied HIGH; missing pull-ups; wrong SDA/SCL pins |
| I²C works, UART garbage | Wrong **crystal frequency** in driver; TX/RX swapped; baud mismatch |
| UART works briefly then stops | IRQ not serviced; FIFO overflow; check **IRQ** wiring |
| Bus hangs after reset | Tie **RESET** to GPIO and add software recovery; power-cycle SC16IS752 |
| Only one RYUW122 responds | Check **TXA/RXA** vs **TXB/RXB** wiring independently |

---

## References

- NXP **SC16IS752** datasheet — register map, I²C timing, FIFO depth, crystal requirements
- REYAX **RYUW122** AT command set — 115200 baud, line-oriented responses
