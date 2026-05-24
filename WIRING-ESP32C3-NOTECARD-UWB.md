# Wiring: Seeed XIAO ESP32-C3 ↔ Blues Notecard (LoRa) ↔ REYAX RYUW122 Lite (UWB)

This document describes how to connect a **Seeed Studio XIAO ESP32-C3** to a **Blues Notecard for LoRa** (typically on a **Notecarrier B**) over **I2C**, and to a **REYAX RYUW122_Lite** UWB module over **UART**.

Firmware defaults match `main/Kconfig.projbuild` (ESP32-C3 targets). After wiring, set the same GPIO numbers in **menuconfig** if you use different pins.

## References

- [Seeed XIAO ESP32C3 wiki / pinout](https://wiki.seeedstudio.com/xiao_esp32c3/)
- [Blues Notecard for LoRa](https://shop.blues.com/products/notecard-lora)
- [Notecarrier B (Feather-compatible carrier)](https://shop.blues.com/products/carr-b) — see Blues [Notecarrier B datasheet](https://dev.blues.io/datasheets/notecarrier-datasheet/notecarrier-b-v3-1/) for silkscreen labels on your revision.
- [REYAX RYUW122_Lite](https://reyax.com/products/RYUW122_Lite) — UART, 3.3 V, AT command set ([AT manual PDF](https://reyax.com//upload/products_download/download_file/AT_Command_RYUW122.pdf)).

---

## Common rules

| Topic | Guidance |
| ----- | -------- |
| **Logic level** | **3.3 V** only. Do not drive 5 V into the Notecard or RYUW122 I/O. |
| **Ground** | Tie **GND** of XIAO, Notecarrier, and RYUW122 **together** (single star or short common return). |
| **I2C** | **SDA ↔ SDA**, **SCL ↔ SCL**. Notecard default **7-bit address `0x17`** (unless changed with a `card.io` request). |
| **UART** | **Cross** TX/RX: **MCU TX → module RX**, **MCU RX ← module TX**. |
| **USB on XIAO** | The XIAO’s **USB-C** port is normally **UART0** for download, monitor, and power. Keep **UART0** free for the PC; use **UART1** for the RYUW122 (firmware default). |

---

## 1. Power

| From | To | Notes |
| ---- | -- | ----- |
| XIAO **3V3** | Notecarrier **3.3 V** (or **VIN** if carrier docs specify 3.3 V in your setup) | Notecard + carrier are 3.3 V devices. |
| XIAO **GND** | Notecarrier **GND** | |
| XIAO **3V3** | RYUW122 **VDD** (or **VCC** per module silk) | Typical **3.3 V**; confirm on your breakout (REYAX spec: ~2.4–3.6 V). |
| XIAO **GND** | RYUW122 **GND** | |

**Current:** UWB can draw **tens of mA** when active; Notecard LoRa TX adds more. Prefer a **solid 3.3 V rail** (short leads). If the board browns out, improve supply or bulk capacitance per Blues / REYAX guidance.

---

## 2. Blues Notecard (LoRa) — I2C via Notecarrier B

The Notecard sits in the **M.2** slot on the carrier; you do **not** wire the M.2 edge directly. You connect the **host MCU (XIAO)** to the carrier’s **host interface** (Feather-style pins and/or **Qwiic / Stemma QT** I2C on many Notecarrier B boards—use the silkscreen on **your** PCB).

### 2.1 Default I2C pins in this firmware (ESP32-C3)

| Signal | ESP32-C3 **GPIO** | Seeed XIAO ESP32-C3 **pad** (typical silk) |
| ------ | ----------------- | ----------------------------------------- |
| **SDA** | **GPIO6** | **D4** (often labeled **SDA** on XIAO) |
| **SCL** | **GPIO7** | **D5** (often labeled **SCL** on XIAO) |

**Important:** pad **D6** is **not** SoC GPIO6 (on XIAO ESP32-C3, **D6** is UART TX / **GPIO21**). Pad **D7** is **not** GPIO7 (**D7** is UART RX / **GPIO20**). If you wire I2C to **D6/D7** by mistake, every I2C transaction will time out. Use **D4/D5** for the defaults above, or set **SEN0140** / **NOTECARD** GPIOs in menuconfig to match the pads you actually use.

These match **Component config → RegattaOne — SEN0140 I2C pins** and **… Blues Notecard …** defaults when the Notecard shares the same bus as the (optional) SEN0140 driver.

### 2.2 Connection table (XIAO ↔ Notecarrier B)

| XIAO ESP32-C3 | Notecarrier B (host side) |
| ------------- | ------------------------- |
| **3V3** | **3.3 V** (Feather **3V** pad, or carrier **3V3** per silk) |
| **GND** | **GND** |
| **D4 / GPIO6** (SDA) | **SDA** (Feather **SDA** / **A4** style label, or **Qwiic SDA**) |
| **D5 / GPIO7** (SCL) | **SCL** (Feather **SCL** / **A5** style label, or **Qwiic SCL**) |

**Important:** Use the **SDA** and **SCL** pads that Blues documents for **host I2C** on *your* Notecarrier B revision—not random GPIO pads. If your carrier only exposes I2C on a **JST-SH Qwiic** connector, you can use a **Qwiic cable** to a [Qwiic breakout for XIAO](https://www.seeedstudio.com/) or hand-wires to **D4/D5**.

### 2.3 I2C electrical notes

- **Frequency:** firmware default **100 kHz** (`NOTECARD_I2C_FREQ_HZ` / SEN0140 bus).
- **Pull-ups:** Notecarrier B normally includes pull-ups on SDA/SCL. If you use a very long cable or a noisy bus, add **~2.2 kΩ–4.7 kΩ** to **3.3 V** on SDA and SCL.
- **Serial-over-I2C:** The Blues stack uses their **serial-over-I2C** framing on this bus (not “plain I2C register” traffic); the ESP firmware implements that when talking to the Notecard.

---

## 3. REYAX RYUW122 Lite — UART

The module is controlled over **UART** (**115200 8N1** factory default per REYAX; firmware also probes **9600** and **57600** at boot).

### 3.1 RYUW122_Lite 6-pin header (count pin 1 at VDD)

Many bring-up failures are **wrong pin on this header** (silk says RX/TX but order is not “top to bottom = RX, TX”).

| Pin | Name | Connect to XIAO |
| --- | ---- | ---------------- |
| **1** | **VDD** | **3V3** |
| **2** | **NRST** | **3V3** (or leave open if module has pull-up — must **not** sit at GND) |
| **3** | **RXD** | **D3 / GPIO5** (ESP **TX** → module **receive**) |
| **4** | **TXD** | **D2 / GPIO4** (ESP **RX** ← module **transmit**) |
| **5** | **PA7** | Leave **unconnected** (do **not** tie to GND — **low = sleep**, UART may not answer) |
| **6** | **GND** | **GND** |

### 3.2 Default UART in this firmware

| Role | ESP32-C3 **GPIO** | Seeed XIAO ESP32-C3 **pad** (typical) |
| ---- | ----------------- | ------------------------------------- |
| **ESP TX** (to module **RXD** pin 3) | **GPIO5** | **D3** |
| **ESP RX** (from module **TXD** pin 4) | **GPIO4** | **D2** |

**Do not use D6/D7 for REYAX** — those pads are **UART0 / USB–serial**. With USB plugged in, wiring the module to D6/D7 gives **no bytes on RX** even though IMU/Notecard work. Use **UART1** on **D2/D3**.

At boot, firmware tries **menuconfig TX/RX** then **swapped TX/RX** and logs which layout gets `+OK`.

### 3.3 Connection table (XIAO ↔ RYUW122_Lite)

| XIAO ESP32-C3 | RYUW122_Lite |
| ------------- | ------------ |
| **3V3** | Pin **1** VDD |
| **GND** | Pin **6** GND |
| **D3 / GPIO5** (MCU **TX**) | Pin **3** **RXD** |
| **D2 / GPIO4** (MCU **RX**) | Pin **4** **TXD** |

Always **cross** data lines: MCU TX → module RXD, MCU RX ← module TXD.

### 3.4 Baud rate

- REYAX default: **115200** (`CONFIG_RYUW122_UART_BAUD`; boot also probes 9600 / 57600).
- If you changed rate with `AT+IPR`, match menuconfig or reset the module.

---

## 4. Changing pins in software

If you route wires to different pads:

1. Run **`idf.py menuconfig`**.
2. Adjust:
   - **RegattaOne — Blues Notecard** → `NOTECARD_I2C_SDA_GPIO`, `NOTECARD_I2C_SCL_GPIO` (standalone bus), and/or **RegattaOne — SEN0140 I2C pins** if the Notecard shares that bus.
   - **RegattaOne — REYAX RYUW122** → `RYUW122_UART_TX_GPIO`, `RYUW122_UART_RX_GPIO`, `RYUW122_UART_BAUD`.

Avoid strapping-sensitive pins and pins reserved for **flash** or **USB/JTAG** on your exact module; the XIAO ESP32-C3 pinout table in the Seeed wiki lists each pad’s GPIO number.

---

## 5. Quick checklist before first boot

- [ ] **3V3** and **GND** correct on all three boards (no 5 V on I/O).
- [ ] **I2C:** SDA→SDA, SCL→SCL; **UART:** TX→RX, RX←TX.
- [ ] **LoRa antenna** attached to the Notecard per Blues instructions (region-appropriate **868 / 915 MHz** module).
- [ ] **UWB** antenna integrated on RYUW122_Lite eval—no extra RF pigtail unless your variant requires it.
- [ ] `idf.py set-target esp32c3` and flash/monitor over **USB**; BLE web UI talks to the same firmware.

---

## 6. Block diagram (logical)

```text
                    ┌─────────────────────┐
   USB-C ──────────►│ Seeed XIAO ESP32-C3 │
                    │                     │
                    │ GPIO6/7 ─I2C───────┼────► Notecarrier B → Notecard (LoRa)
                    │                     │        (SDA/SCL, 3V3, GND)
                    │ GPIO4/5 ─UART1─────┼────► RYUW122_Lite (RX/TX, 3V3, GND)
                    │                     │
                    └─────────────────────┘
```

This matches the intended **boat** stack: **Notecard** on **I2C**, **UWB** on **UART**, **BLE** to the browser for configuration and live data.
