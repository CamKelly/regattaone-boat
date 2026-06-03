# RegattaOne Boat

ESP-IDF **firmware** for **ESP32-S3** (**DevKitM-1 / WEMOS Mini** or **Waveshare ESP32-S3-Zero**) or **ESP32-C3** that bridges an **SX1262 LoRa** module (SPI / RadioLib), a **GPS** (NMEA 0183 UART + PPS), a **REYAX RYUW122_Lite** UWB module (UART), optional **SEN0140** IMU (I2C), and **Chrome over Web Bluetooth** on the same NimBLE GATT service. An **Angular + Ionic** web app connects to the device and shows **UWB UART** lines (Notecard JSON UI remains for legacy ESP32-C3 builds).

BLE advertised name: random **4-character** code (A–Z, a–z, 0–9), persisted in NVS until you assign a boat ID.

---

## What you get

| Layer | Role |
| ----- | ---- |
| **Firmware** (`main/`) | NimBLE GATT **0xFEF0**; optional **SEN0140** IMU task (**0xFEF1**); **SX1262** LoRa SPI (RadioLib, menuconfig); **GPS** NMEA UART + PPS; **RYUW122** UART lines → **0xFEF9** notify; legacy **Blues Notecard** I2C (**0xFEF7** / **0xFEF8**, C3 only); optional **MSP430** paths (**default off** on S3). |
| **Web app** (`web/`) | **Web Bluetooth**: connect by service UUID, live **UWB** logs (Notecard tab for legacy C3). |
| **Backend** (`backend/`) | Firebase Cloud Functions, Firestore rules, Notehub webhooks (legacy Notecard), device presence sync, and admin PWA (`backend/client/`). |
| **Wiring** | **[WIRING-ESP32S3-LORA-GPS.md](WIRING-ESP32S3-LORA-GPS.md)** — DevKit Mini or Waveshare Zero ↔ SX1262 ↔ GPS ↔ RYUW122 ↔ SEN0140. C3 + Notecard: **[WIRING-ESP32C3-NOTECARD-UWB.md](WIRING-ESP32C3-NOTECARD-UWB.md)**. |

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
# ESP32-S3 — pick board (see WIRING-ESP32S3-LORA-GPS.md)
./scripts/idf-s3.sh devkit-mini set-target esp32s3      # DevKitM-1 / WEMOS Mini
# ./scripts/idf-s3.sh waveshare-zero set-target esp32s3 # Waveshare ESP32-S3-Zero

./scripts/idf-s3.sh devkit-mini build
./scripts/idf-s3.sh devkit-mini -p PORT flash monitor

# ESP32-C3 (legacy Notecard path):
idf.py set-target esp32c3
idf.py build
idf.py -p PORT flash monitor
```

When **switching S3 boards**, delete `sdkconfig` first so pin defaults refresh.

- **`components/RadioLib/`** — vendored [RadioLib](https://github.com/jgromes/RadioLib) v7.6.0 (ESP-IDF discovers it automatically; no component manager needed).
- **Pins:** **Component config → RegattaOne — ESP32-S3 board** (or board fragments via `scripts/idf-s3.sh`), then per-peripheral GPIO menus.

After changing target: if CMake complains, run **`idf.py fullclean`** once, then **`idf.py set-target …`** and **`idf.py build`** again.

### Main firmware modules

| Path | Purpose |
| ---- | ------- |
| `main/regattaone-laser.c` | `app_main`: NVS, I2C mux, SEN0140 (optional), BLE, SX1262 LoRa, RYUW122 UART task, MSP430 (optional). |
| `main/ble_sen0140.c` / `.h` | NimBLE service **0xFEF0** and characteristics **0xFEF1–0xFEF9** (see table below). |
| `main/sx1262_lora.c` / `.cpp` / `.h` | SX1262 LoRa over SPI (RadioLib). |
| `main/radiolib_esp_hal.hpp` | ESP-IDF SPI master HAL for RadioLib. |
| `main/ryuw122_uart.c` / `.h` | UART listener → BLE **0xFEF9** notifies. |
| `main/i2c_bus_mux.c` / `.h` | Mutex so SEN0140 and Notecard can share one I2C bus. |
| `main/sen0140_10dof.c` / `.h` | Optional DFRobot SEN0140 IMU (legacy; disable by not wiring / init failure). |
| `main/msp430_*.c` | Optional MSP430 BSL / UART bridge (**`CONFIG_REGATTAONE_MSP430_ENABLE`** default **n**). |

---

## BLE GATT (Web Bluetooth & other clients)

Service **16-bit UUID `0xFEF0`** (full UUID `0000fef0-0000-1000-8000-00805f9b34fb`).

| Char | UUID (16-bit) | Direction | Purpose |
| ---- | ------------- | --------- | ------- |
| IMU | `0xFEF1` | Notify | Binary IMU packet (`sen0140_ble_imu_pkt_t`) if SEN0140 task runs. |
| MSP430 UART | `0xFEF2` | Notify | Raw UART bytes (if MSP430 enabled). |
| MSP430 BSL invoke | `0xFEF3` | Write | BSL entry (if MSP430 enabled). |
| MSP430 FW upload | `0xFEF4` | Write | Chunked upload (if enabled). |
| MSP430 flash status | `0xFEF5` | Notify | UTF-8 status lines (if enabled). |
| MSP430 GPIO | `0xFEF6` | Write | RST/TEST levels (if enabled). |
| **Notecard request** | **`0xFEF7`** | **Write** | UTF-8 JSON line, **must end with `\n`**. |
| **Notecard response** | **`0xFEF8`** | **Notify** | UTF-8 JSON response (chunked). |
| **UWB UART line** | **`0xFEF9`** | **Notify** | UTF-8 line(s) from RYUW122 (chunked if long). |

The maintained web client uses **`0xFEF7` / `0xFEF8` / `0xFEF9`** and **`web/src/lib/protocol.ts`** for those UUIDs.

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

## Backend (Firebase + Notehub)

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
| [backend/docs/notehub-setup.md](backend/docs/notehub-setup.md) | `boat.qo` lifecycle webhook |
| [backend/docs/device-presence-sync.md](backend/docs/device-presence-sync.md) | `presence.qi` / `presence_ack.qo` |

Firmware notefiles consumed by the backend:

| Notefile | Direction | Purpose |
| -------- | --------- | ------- |
| `boat.qo` | Device → cloud | Boot / ID / type (`notehubDeviceLifecycle`) |
| `presence_ack.qo` | Device → cloud | Presence delivery ack (`notehubPresenceAck`) |
| `presence.qi` | Cloud → device | Presence deltas (read by firmware `presence_sync`) |

---

## Optional: SEN0140 IMU (legacy)

If the **SEN0140** 10-DOF breakout is wired on the same I2C bus as the Notecard, firmware can still run the IMU task and stream **0xFEF1**. Pin defaults for **ESP32-C3 (XIAO)** are **GPIO6 SDA / GPIO7 SCL** (menuconfig). More detail: **[WIRING-SEN0140.md](WIRING-SEN0140.md)**.

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
│   ├── blues_notecard.c / .h    # Notecard I2C
│   ├── ryuw122_uart.c / .h       # UWB UART → BLE
│   ├── i2c_bus_mux.c / .h
│   ├── sen0140_10dof.c / .h     # Optional IMU
│   ├── msp430_*.c / .h          # Optional MSP430 (off by default)
│   └── Kconfig.projbuild
├── web/                           # Angular app (BLE boat UI)
├── backend/                       # Firebase functions, Firestore, admin PWA
│   ├── client/                    # Angular admin PWA (hosted on Firebase)
│   ├── functions/                 # Cloud Functions (Notehub, presence sync)
│   ├── shared/                    # @regattaone/shared types
│   └── docs/                      # Notehub + presence setup
├── web-vite-legacy/               # Old Vite client (reference)
├── WIRING-ESP32S3-LORA-GPS.md   # Primary wiring (ESP32-S3 Mini)
├── WIRING-ESP32C3-NOTECARD-UWB.md # Legacy C3 + Notecard wiring
├── WIRING-SEN0140.md             # Optional IMU wiring
└── .clangd                        # clangd: CompileFlags + build/compile_commands.json
```

---

## Troubleshooting

| Symptom | Check |
| ------- | ----- |
| **Build fails after retarget** | `idf.py fullclean`, then `set-target` and `build` again. |
| **No Bluetooth in browser** | Chrome, **HTTPS** or **localhost**, OS Bluetooth on. |
| **Connect fails** | Firmware running? Correct chip flashed? Device advertising **0xFEF0**? |
| **Notecard write errors** | JSON ends with **newline**; I2C wiring and **3.3 V**; default Notecard address **0x17**. |
| **No UWB lines** | UART **TX/RX crossed**; baud matches module (default **115200**); GPIOs match menuconfig. |
| **clangd / IDE flags** | Run **`idf.py build`** so **`build/compile_commands.json`** exists; `.clangd` points **`CompileFlags.CompilationDatabase`** at **`build`**. |

---

## License / origin

`main/regattaone-laser.c` retains SPDX headers from the Espressif template. Other files follow your project’s license choices. Blues **serial-over-I2C** behavior is aligned with the public **note-arduino** / Notecard host model; cite Blues when redistributing derived protocol code.

---

## Quick reference

```bash
idf.py set-target esp32s3   # or esp32c3
idf.py build
idf.py -p /dev/tty.usbmodem* flash monitor

cd web && npm install && npm run dev
```
