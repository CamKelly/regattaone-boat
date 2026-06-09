# RegattaOne Boat

ESP-IDF **firmware** for **ESP32-S3** (**DevKitM-1 / WEMOS Mini**, **Freenove ESP32-S3 WROOM Lite**, or **Waveshare ESP32-S3-Zero**) or **ESP32-C3** that bridges an **SX1262 LoRa** module (SPI / RadioLib), a **GPS** (NMEA 0183 UART + PPS), a **REYAX RYUW122_Lite** UWB module (UART), optional **SEN0140** IMU (I2C), and **Chrome over Web Bluetooth** on the same NimBLE GATT service. An **Angular + Ionic** web app connects to the device and shows **LoRa**, **GPS**, and **UWB** traffic.

BLE advertised name: random **4-character** code (A–Z, a–z, 0–9), persisted in NVS until you assign a boat ID.

---

## What you get

| Layer | Role |
| ----- | ---- |
| **Firmware** (`main/`) | NimBLE GATT **0xFEF0**; optional **SEN0140** IMU task (**0xFEF1**); **SX1262** LoRa SPI (RadioLib, menuconfig); **GPS** NMEA UART + PPS; **RYUW122** UART lines → **0xFEF9** notify. |
| **Web app** (`web/`) | **Web Bluetooth**: connect by service UUID, **LoRa** / **GPS** / **UWB** tabs. |
| **Backend** (`backend/`) | Firebase Cloud Functions, Firestore rules, and admin PWA (`backend/client/`) — optional cloud stack, not required for on-boat BLE bring-up. |
| **Wiring** | **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** — DevKit Mini, Freenove WROOM Lite, or Waveshare Zero ↔ SX1262 ↔ GPS ↔ RYUW122 ↔ SEN0140. Pinouts: **[FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md](FREENOVE-ESP32S3-WROOM-LITE-PINOUT.md)**, **[WAVESHARE-ESP32S3-ZERO-PINOUT.md](WAVESHARE-ESP32S3-ZERO-PINOUT.md)**. **PPS / TDMA:** **[TDMA-GPS-PPS.md](TDMA-GPS-PPS.md)**. |

---

## Prerequisites

1. **ESP-IDF** 5.x (CI / docs often use **v5.x**; this tree is also used with **ESP-IDF 6** in some setups). Install per [Espressif getting started](https://docs.espressif.com/projects/esp-idf/en/latest/esp32c3/get-started/index.html) for your chip, then:

   ```bash
   . $HOME/esp/esp-idf/export.sh   # adjust to your IDF path
   ```

2. **Node.js** 18+ and **npm** (for `web/`).

3. **Chrome** (desktop or Android) for **Web Bluetooth**. Page must be a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): **`https://`** or **`http://localhost`**.

4. **USB cable** for flash / serial monitor on the dev board.

---

## Firmware: build, flash, monitor

From the **repository root**:

```bash
# remove last build / config
rm -rf build
rm -f sdkconfig
# ESP32-S3 — pick board (see WIRING-ESP32S3-LORA-GPS.md)
./scripts/idf-s3.sh devkit-mini set-target esp32s3      # DevKitM-1 / WEMOS Mini
# ./scripts/idf-s3.sh freenove set-target esp32s3     # Freenove ESP32-S3 WROOM Lite
# ./scripts/idf-s3.sh waveshare-zero set-target esp32s3 # Waveshare ESP32-S3-Zero

./scripts/idf-s3.sh devkit-mini build
./scripts/idf-s3.sh devkit-mini -p PORT flash monitor

# ESP32-C3:
idf.py set-target esp32c3
idf.py build
idf.py -p PORT flash monitor
```

When **switching S3 boards**, delete `sdkconfig` first so pin defaults refresh.

**Waveshare Zero** default: **GPS + LoRa** on edge pins **GP4–GP13** only (no GP14–18); IMU/UWB off — [WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md).

- **`components/RadioLib/`** — [RadioLib](https://github.com/jgromes/RadioLib) v7.6.0 (local component; works with component manager off). HAL: `main/EspHal.h` ([ESP-IDF example](https://github.com/jgromes/RadioLib/tree/master/examples/NonArduino/ESP-IDF) style, ESP32-S3/C3 `esp_driver_spi`).
- **Pins:** **Component config → RegattaOne — ESP32-S3 board** (or board fragments via `scripts/idf-s3.sh`), then per-peripheral GPIO menus.

After changing target: if CMake complains, run **`idf.py fullclean`** once, then **`idf.py set-target …`** and **`idf.py build`** again.

### Main firmware modules

| Path | Purpose |
| ---- | ------- |
| `main/regattaone-laser.c` | `app_main`: NVS, I2C mux, SEN0140 (optional), BLE, SX1262 LoRa, RYUW122 UART task. |
| `main/ble_sen0140.c` / `.h` | NimBLE service **0xFEF0** and characteristics (see table below). |
| `main/sx1262_lora.c` / `.cpp` / `.h` | SX1262 LoRa over SPI (RadioLib). |
| `main/EspHal.h` | RadioLib ESP-IDF HAL (`esp_driver_spi`; based on official ESP-IDF example). |
| `main/ryuw122_uart.c` / `.h` | UART listener → BLE **0xFEF9** notifies. |
| `main/i2c_bus_mux.c` / `.h` | Mutex for shared I2C bus access. |
| `main/sen0140_10dof.c` / `.h` | Optional DFRobot SEN0140 IMU. |

---

## BLE GATT (Web Bluetooth & other clients)

Service **16-bit UUID `0xFEF0`** (full UUID `0000fef0-0000-1000-8000-00805f9b34fb`).

| Char | UUID (16-bit) | Direction | Purpose |
| ---- | ------------- | --------- | ------- |
| IMU | `0xFEF1` | Notify | Binary IMU packet (`sen0140_ble_imu_pkt_t`) if SEN0140 task runs. |
| **LoRa TX** | **`0xFEF7`** | **Write** | UTF-8 payload (optional `TTL=<ms>\n` prefix). |
| **LoRa RX / status** | **`0xFEF8`** | **Notify** | UTF-8 lines from LoRa RX and `! STATUS:` diagnostics. |
| **LoRa stats** | **`0xFEFE`** | **Read/Notify/Write** | Session JSON (`tx`, per-sender RX gaps, `mesh` peer roster). Write `stream=1`/`0` (auto-send) or `mesh=1`/`0` (democratic ephemeral mesh IDs). |
| **UWB UART line** | **`0xFEF9`** | **Notify** | UTF-8 line(s) from RYUW122 (chunked if long). |
| UWB AT | `0xFEFA` | Write | AT command (CRLF appended if missing); responses on **0xFEF9**. |
| Boat ID | `0xFEFB` | Read/Write | User boat id (NVS). |
| Device type | `0xFEFC` | Read/Write | port / starboard / fixed_dgps_mark / waypoint / boat. |
| GPS NMEA | `0xFEFD` | Notify | GPS UART lines when GPS enabled. |

The web client uses **`web/src/lib/protocol.ts`** for these UUIDs.

---

## Web app

**Ionic + Angular** standalone app.

```bash
cd web
npm install
npm run dev
```

Open **Chrome** at **`http://localhost:5173`** (or the URL printed by `ng serve`). Click **Connect Bluetooth**, pick your device (4-char name or custom boat ID, service **`0xFEF0`**), then use the **LoRa** / **GPS** / **UWB** tabs as wired.

Production build:

```bash
cd web && npm run build
```

Output under **`web/dist/regattaone-web/browser/`** (serve over **HTTPS** if not on localhost—Web Bluetooth requires a secure context).

A legacy **Vite** snapshot lives in **`web-vite-legacy/`**; day-to-day development uses **`web/`**.

---

## Backend (Firebase)

Cloud Functions, Firestore, and the admin PWA live under **`backend/`**. Run Firebase CLI commands from that directory:

```bash
cd backend
npm install
npm run build -w @regattaone/shared
firebase deploy --only functions,firestore
```

| Doc | Topic |
| --- | ----- |
| [backend/README.md](backend/README.md) | Setup, emulators, deploy |

---

## Optional: SEN0140 IMU

If the **SEN0140** 10-DOF breakout is wired on I2C, firmware can run the IMU task and stream **0xFEF1**. Pin defaults for **ESP32-C3 (XIAO)** are **GPIO6 SDA / GPIO7 SCL** (menuconfig). More detail: **[WIRING-SEN0140.md](WIRING-SEN0140.md)**.

---

## Repository layout

```text
regattaone-boat/
├── CMakeLists.txt                 # ESP-IDF project root
├── sdkconfig.defaults             # Shared BT / NimBLE defaults
├── sdkconfig.defaults.esp32c3     # C3-specific (optional merge)
├── sdkconfig.defaults.esp32s3     # S3-specific (optional merge)
├── main/
│   ├── regattaone-laser.c         # app_main
│   ├── ble_sen0140.c / .h         # NimBLE GATT
│   ├── sx1262_lora.cpp / .h       # LoRa SPI → BLE
│   ├── ryuw122_uart.c / .h        # UWB UART → BLE
│   ├── i2c_bus_mux.c / .h
│   ├── sen0140_10dof.c / .h       # Optional IMU
│   └── Kconfig.projbuild
├── web/                           # Angular app (BLE boat UI)
├── backend/                       # Firebase functions, Firestore, admin PWA
├── WIRING-ESP32S3-LORA-GPS.md     # Primary wiring (ESP32-S3)
├── WIRING-SEN0140.md              # Optional IMU wiring
└── .clangd                        # clangd: CompileFlags + build/compile_commands.json
```

---

## Troubleshooting

| Symptom | Check |
| ------- | ----- |
| **Build fails after retarget** | `idf.py fullclean`, then `set-target` and `build` again. |
| **No Bluetooth in browser** | Chrome, **HTTPS** or **localhost**, OS Bluetooth on. |
| **Connect fails** | Firmware running? Correct chip flashed? Device advertising **0xFEF0**? |
| **LoRa init failed (-2)** | SPI wiring and CS/RST/BUSY GPIOs vs menuconfig; 3.3 V to module. |
| **No UWB lines** | UART **TX/RX crossed**; baud matches module (default **115200**); GPIOs match menuconfig. |
| **clangd / IDE flags** | Run **`idf.py build`** so **`build/compile_commands.json`** exists; `.clangd` points **`CompileFlags.CompilationDatabase`** at **`build`**. |

---

## License / origin

`main/regattaone-laser.c` retains SPDX headers from the Espressif template. Other files follow your project’s license choices.

---

## Quick reference

```bash
idf.py set-target esp32s3   # or esp32c3
idf.py build
idf.py -p PORT flash monitor
```
