# RegattaOne Laser

ESP32-S3 **firmware** that reads a **DFRobot SEN0140** 10-DOF IMU over **I2C** and streams samples over **BLE NimBLE**, plus a **web app** (Chrome + Web Bluetooth) that fuses the IMU in the browser (**Madgwick**), draws a **live 3D board** matching orientation on your table, and exposes **camera pan/tilt** so you can frame the scene like the device in front of you.

This is **not** a hello-world template; the stock ESP-IDF example text has been replaced by this project.

---

## What you get

| Layer | Role |
| ----- | ---- |
| **Firmware** (`main/`) | Init I2C, probe ADXL345 / ITG-3200 / mag / baro, read ~50 Hz, notify a binary IMU packet over GATT; optional UART CSV for debugging. |
| **Web app** (`web/`) | Pair over Web Bluetooth, parse packets, Madgwick MARG/IMU fusion, Three.js scene with PCB photo, grid + axis helpers, heading compass, bubble level, optional mag X/Y plot, **camera pan & tilt** (orbit around the board center). |

BLE advertised name: **`RegattaOne-SEN0140`**.

---

## Prerequisites

1. **ESP-IDF** (5.x; project tested with ESP32-S3). Install per [Espressif getting started](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/index.html), then in every new terminal:

   ```bash
   . $HOME/esp/esp-idf/export.sh   # adjust path to your IDF clone
   ```

2. **Node.js** 18+ and **npm**.

3. **Chrome** (desktop or Android) for **Web Bluetooth**. The page must be a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): **`https://`** or **`http://localhost`** (Vite dev server qualifies).

4. **USB cable** and driver for your ESP32-S3 board.

---

## Hardware: SEN0140 ↔ ESP32-S3

The **SEN0140** ([DigiKey datasheet PDF](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/2524/SEN0140_Web.pdf)) is a **10-DOF** module on one I2C bus: **ADXL345** accel, **ITG-3200** gyro, **magnetometer** (several possible chips), **BMP085/BMP280** baro. It is **not** a color sensor.

### Connections (ESP32-S3 Mini–style layout)

Firmware defaults in `main/sen0140_10dof.h` use **GPIO10 = SDA** and **GPIO11 = SCL**, matching **header pin 10 → SDA** and **pin 11 → SCL** when silkscreened **IO10** / **IO11** (typical WEMOS/LOLIN ESP32-S3 Mini).

| SEN0140 pin | ESP32-S3 Mini | SoC GPIO | Notes |
| ----------- | ------------- | -------- | ----- |
| **VCC** | **3.3 V** | — | Module accepts ~3–8 V; **3.3 V** is appropriate for ESP32. |
| **GND** | **GND** | — | Common ground. |
| **SDA** | **Pin 10** (IO10) | **GPIO 10** | Must match `SEN0140_I2C_SDA_GPIO`. |
| **SCL** | **Pin 11** (IO11) | **GPIO 11** | Must match `SEN0140_I2C_SCL_GPIO`. |

If your board’s **physical** pin numbers do **not** map to GPIO10/11, use the **GPIO numbers printed on the PCB** and update the defines in `main/sen0140_10dof.h`:

```c
#define SEN0140_I2C_SDA_GPIO    10
#define SEN0140_I2C_SCL_GPIO    11
```

Pick pins that are free and not used for flash/PSRAM straps on your module.

Follow the **SEN0140 breakout silkscreen** for SDA/SCL order (some boards label **VCC, GND, SCL, SDA**).

### I2C details

- **Logic:** 3.3 V (same as ESP32-S3).
- **Pull-ups:** The DFRobot board usually has SDA/SCL pull-ups; firmware also enables weak internal pull-ups. Add external **~4.7 kΩ** to 3.3 V if the bus is noisy or uses long wires.
- **Speed:** **100 kHz** in code (`SEN0140_I2C_FREQ_HZ`).

### Magnetometer auto-detect

The compass shares **SDA/SCL/GND/3V3** only. Firmware probes in order (see `sen0140_10dof.c`): LIS3MDL @ `0x1E`, HMC5883L path, LIS3MDL @ `0x1C`, QMC5883L, then `0x0C` (VCM5883L / AK8963 disambiguated by chip ID).

| Chip | 7-bit address | Notes |
| ---- | ------------- | ----- |
| **HMC5883L** | `0x1E` | DFRobot SEN0140; data order **X, Z, Y** in chip. |
| **LIS3MDL** | `0x1E` / `0x1C` | WHO_AM_I `0x3D` @ `0x0F`. |
| **QMC5883L** | `0x0D` | Common on GY-271-style boards. |
| **VCM5883L** | `0x0C` | Chip ID `0x82` @ `0x0C`. |
| **AK8963** | `0x0C` / `0x0D` | WHO_AM_I `0x48` @ `0x00`. |

On boot, a log line such as `Magnetometer: VCM5883L @ 0x0c` shows which mag was found.

### Barometer

Firmware probes **BMP085/BMP280** at **`0x77`** then **`0x76`**. BMP280 chip id **`0x58`** @ **`0xD0`**; BMP085 **`0x55`** @ **`0xD0`**. When present, UART loop can print **°C** and **hPa**.

### I2C address cheat sheet (same bus)

| Sensor | Address |
| ------ | ------- |
| ADXL345 | `0x53` (tries `0x1D` if SDO strapped other way) |
| ITG-3200 | `0x68` |
| HMC5883L | `0x1E` |
| LIS3MDL | `0x1E` or `0x1C` |
| QMC5883L | `0x0D` |
| VCM5883L | `0x0C` (factory may vary) |
| AK8963 | `0x0C` / `0x0D` |
| BMP085 | `0x77` |
| BMP280 | `0x77` or `0x76` |

The same wiring content is kept in **`WIRING-SEN0140.md`** for a dedicated hardware-only reference.

---

## Firmware build, flash, and monitor

From the **repository root** (where the top-level `CMakeLists.txt` lives):

1. **Set target** (first clone, or when changing chip):

   ```bash
   idf.py set-target esp32s3
   ```

   `sdkconfig.defaults` sets **`CONFIG_IDF_TARGET="esp32s3"`**, **BLE only**, **NimBLE** enabled (required for `ble_sen0140.c`).

2. **Configure** (optional): `idf.py menuconfig` — usually unnecessary if defaults match your board.

3. **Build:**

   ```bash
   idf.py build
   ```

4. **Flash and serial monitor** (replace `PORT` with your device, e.g. `/dev/tty.usbmodem101`, `COM5`):

   ```bash
   idf.py -p PORT flash monitor
   ```

5. **Exit monitor:** `Ctrl-]`.

Expected log lines include SEN0140 init (**SDA/SCL GPIO**), magnetometer detection, **NimBLE** start, and periodic **UART** human + CSV lines (~every **500 ms**). The IMU notification rate to BLE is driven by the sensor task (**20 ms** period in `regattaone-laser.c` → ~50 Hz).

### Main source files

| File | Purpose |
| ---- | ------- |
| `main/regattaone-laser.c` | `app_main`: NVS, `sen0140_board_init`, `ble_sen0140_init`, sensor FreeRTOS task. |
| `main/sen0140_10dof.c` / `.h` | I2C driver, chip probe, `sen0140_read_sample`, UART print helpers. |
| `main/ble_sen0140.c` / `.h` | NimBLE GATT service **0xFEF0**, notify characteristic **0xFEF1**, binary packet layout. |
| `sdkconfig.defaults` | `esp32s3`, `CONFIG_BT_NIMBLE_ENABLED=y`, Bluedroid off. |

---

## Web app: install, run, use

The UI is an **Ionic 8 + Angular 19** standalone app (same BLE / Three.js / PGA behavior as before, with a clearer header: **Connect / Disconnect** and an **SEN0140 | PGA460** segment control).

### Install (once)

```bash
cd web
npm install
```

### Development server

```bash
npm run dev
```

Open **Chrome** at **`http://localhost:5173`** (or the host/port shown in the terminal; `npm run start` uses the same defaults).

### Using the UI (checklist)

1. **Connect Bluetooth** — choose **`RegattaOne-SEN0140`**. Keep the tab in the foreground; some platforms throttle background tabs.
2. With the **PCB flat and level** on the table, click **Align when flat** once so the 3D model matches your desk reference.
3. **3D view** — board orientation updates from fused quaternion; grid and colored world axes show +X/+Y/+Z; green **N** is grid “north” (+Z).
4. **Heading** — numeric readout and bottom-right compass vs green N.
5. **Bubble level** (top-right) — tilt vs gravity from the IMU (not affected by Align).
6. **Mag X/Y plot** — optional overlay on the board when mag data is present.
7. **Camera pan & tilt** — left panel: orbit the **camera** around the fixed look target at the board center (**pan** = yaw around vertical; **tilt** = pitch up/down; distance unchanged). **Reset pan & tilt** restores the default framing. This does **not** change firmware or sensor fusion.

### Production build (optional)

```bash
cd web
npm run build
```

Static output is under **`web/dist/regattaone-web/browser/`** (serve that folder). For a quick local check: `npx ng serve` / `npm run dev` is simpler than a static server.

Serve the built files over **HTTPS** if you host remotely (Web Bluetooth requires a secure context).

A **Vite-only snapshot** of the previous client (if you need it) lives in **`web-vite-legacy/`** at the repo root; the maintained app is **`web/`**.

---

## BLE GATT (for debugging or other clients)

| Item | Value |
| ---- | ----- |
| Service UUID (16-bit) | `0xFEF0` → `0000fef0-0000-1000-8000-00805f9b34fb` |
| IMU notify | `0xFEF1` → `0000fef1-0000-1000-8000-00805f9b34fb` |
| MSP430 UART notify | `0xFEF2` → `0000fef2-0000-1000-8000-00805f9b34fb` |
| MSP430 BSL invoke (write, any small payload) | `0xFEF3` → `0000fef3-0000-1000-8000-00805f9b34fb` — ESP32 toggles **RST/TEST** GPIOs per TI SLAU550 §3.3.2; requires wiring from `main/msp430_bsl_invoke.h` defaults |
| MSP430 FW upload (write, framed chunks) | `0xFEF4` → framed **TI-TXT** transfer + on-device BSL flash (see web MSP430 tab) |
| MSP430 flash status (notify, UTF-8 lines) | `0xFEF5` → progress / errors during programming |

Packet layout matches **`sen0140_ble_imu_pkt_t`** in `main/ble_sen0140.c` and **`web/src/lib/protocol.ts`** (little-endian): version, flags, seq, accel (g), gyro (rad/s), mag (int16), optional v2 **temp_c** / **press_hpa** floats.

---

## Repository layout (important paths)

```text
regattaone-laser/
├── PGA460 Datasheet.pdf        # TI SLASEJ4C — UART §7.3.6.2 / Table 7-3 (copied into web build as datasheets/)
├── CMakeLists.txt              # ESP-IDF project root
├── sdkconfig.defaults          # esp32s3 + NimBLE defaults
├── main/
│   ├── CMakeLists.txt
│   ├── regattaone-laser.c      # app_main + sensor task
│   ├── sen0140_10dof.c/.h      # I2C / SEN0140
│   ├── ble_sen0140.c/.h        # NimBLE GATT (IMU + MSP430 UART + BSL write)
│   ├── msp430_bsl_invoke.c/.h # MSP430 BSL hardware entry (RST/TEST)
│   ├── msp430_bsl_flash.c/.h  # TI-TXT + SLAU550 UART BSL programming
│   ├── msp430_fw_upload.c/.h # BLE chunk reassembly → flash task
│   ├── pga460_uart.c/.h        # PGA460 UART driver (ESP-IDF)
│   ├── pga460_ussc.c/.h        # TI USSC-style commands (UART port of TI sketch)
│   ├── PGA460_USSC_PORT.md     # How the USSC reference maps to this firmware
│   └── PGA460_USSC_G2553.cpp   # TI Energia reference (not compiled; keep for comparison)
├── web/                        # Ionic + Angular (standalone) client
│   ├── angular.json
│   ├── package.json
│   └── src/
│       ├── app/                # Shell (Ionic header + segment)
│       ├── assets/images/      # `sen0140-board.png` — 3D PCB texture (copied from `web-vite-legacy/public/`)
│       ├── lib/                # protocol, madgwick, magPlot, pgaPanel, plots
│       ├── regatta-main.ts     # BLE, Three.js, PGA wiring (bootstrapped from AppComponent)
│       └── regatta-styles.css  # Layout + PGA EVM (from prior Vite app)
├── web-vite-legacy/            # Optional: previous Vite + vanilla TS client (not the default build)
├── WIRING-SEN0140.md           # Wiring reference (duplicate of README hardware section)
├── WIRING-PGA460.md            # PGA460 carrier: power + UART to ESP32-S3
└── pytest_hello_world.py       # Legacy ESP-IDF CI helper from template (optional)
```

---

## Troubleshooting

| Symptom | Things to check |
| ------- | ---------------- |
| **Firmware won’t start / I2C errors** | Wiring table above; 3.3 V; SDA/SCL not swapped; `SEN0140_I2C_SDA_GPIO` / `SCL` match your board; shorter wires; external pull-ups. |
| **No magnetometer / wrong mag** | Boot log for detected chip; address conflicts; clone boards with QMC5883L instead of HMC. |
| **Build errors for BT** | `sdkconfig` must have **NimBLE** on, **Bluedroid** off (see `sdkconfig.defaults`). Run `idf.py fullclean` after retargeting. |
| **Flash fails** | Correct `PORT`, USB cable with data lines, hold BOOT if your board requires it, lower baud in `menuconfig` if needed. |
| **Chrome: no Bluetooth / no device** | Use **Chrome**; **HTTPS** or **localhost**; Bluetooth on; device not paired only to OS in a way that blocks new connections (remove old pairing if stuck). |
| **Connects but no motion** | Notifications enabled? Firmware running sensor task? Check status text in UI for packet flags and `dt`. |
| **Model doesn’t match table** | **Align when flat** with board level; re-run after major firmware/sensor changes. |
| **Drift / noisy heading** | Move away from metal/PC speakers; mag fusion sensitive to environment; baro/mag optional for basic tilt. |

For ESP-IDF toolchain and CMake details, see the [ESP-IDF build system](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-guides/build-system.html).

---

## License / origin

`main/regattaone-laser.c` retains SPDX headers from the Espressif template; application-specific files (`sen0140_10dof.*`, `ble_sen0140.*`, `web/`) follow your project licensing choices.

---

## Quick reference commands

```bash
# Firmware (from repo root, ESP-IDF exported)
idf.py set-target esp32s3
idf.py build
idf.py -p PORT flash monitor

# Web
cd web && npm install && npm run dev
```

When you return after a long break: **wire per the table → flash firmware → verify UART → `npm install` in `web/` if package.json changed → `npm run dev` → Chrome → Connect → Align when flat → adjust camera pan/tilt as needed.**
