# SEN0140 (10 DOF) ↔ ESP32-S3 wiring

The DFRobot **SEN0140** in the [DigiKey datasheet](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/2524/SEN0140_Web.pdf) is a **10-DOF IMU** on one I2C bus (ADXL345 accelerometer, ITG-3200 gyro, HMC5883L magnetometer, BMP085 barometer). It is **not** a color sensor.

## Connections (ESP32-S3 Mini — your layout)

Firmware in `main/sen0140_10dof.h` uses **GPIO10 = SDA** and **GPIO11 = SCL**, matching **header pin 10 → SDA** and **pin 11 → SCL** when those holes are silkscreened **IO10** / **IO11** (typical WEMOS/LOLIN ESP32-S3 Mini).

| SEN0140 pin | ESP32-S3 Mini          | GPIO (SoC)  | Notes                                              |
|-------------|------------------------|-------------|----------------------------------------------------|
| **VCC**     | **3.3 V**              | —           | Board accepts ~3–8 V; 3.3 V is fine.               |
| **GND**     | **GND**                | —           | Common ground.                                     |
| **SDA**     | **Pin 10** (IO10)      | **GPIO 10** | Must match `SEN0140_I2C_SDA_GPIO`.                 |
| **SCL**     | **Pin 11** (IO11)      | **GPIO 11** | Must match `SEN0140_I2C_SCL_GPIO`.                 |

If your board’s silkscreen does **not** map physical pin 10/11 to GPIO10/11, use the GPIO numbers printed on the PCB and set them in `sen0140_10dof.h`.

Follow the silkscreen on the SEN0140 breakout for **SDA/SCL** order (some label **VCC, GND, SCL, SDA**).

## I2C

- **Voltage:** 3.3 V logic (same as ESP32-S3).
- **Pull-ups:** The DFRobot board usually includes pull-ups on SDA/SCL. The firmware also enables weak internal pull-ups; add external **~4.7 kΩ** to 3.3 V if the bus is noisy or runs long wires.
- **Speed:** 100 kHz in code (`SEN0140_I2C_FREQ_HZ`).

### Magnetometer (HMC5883L, QMC5883L, LIS3MDL, VCM5883L, AK8963)

The compass IC is on the **same** I2C bus as the other sensors — only **SDA**, **SCL**, **3.3 V**, and **GND** to the ESP32.

Firmware probes in a fixed order (LIS3MDL at `0x1E`, HMC, LIS3MDL at `0x1C`, QMC, then `0x0C`):

| Chip          | 7-bit address   | Notes                                                                   |
|---------------|-----------------|-------------------------------------------------------------------------|
| **HMC5883L**  | `0x1E`          | DFRobot SEN0140 / Honeywell; data registers **X, Z, Y**.                |
| **LIS3MDL**   | `0x1E` / `0x1C` | WHO_AM_I `0x3D` @ `0x0F`; common substitute on 10-DOF boards.           |
| **QMC5883L**  | `0x0D`          | Very common on GY-271 and clones sold as “HMC5883L”.                    |
| **VCM5883L**  | `0x0C`          | Chip ID `0x82` @ register `0x0C` (Vtran datasheet); data `0x00`–`0x05`. |
| **AK8963**    | `0x0C` / `0x0D` | WHO_AM_I `0x48` @ `0x00`; same `0x0C` as VCM5883L — ID disambiguates.   |

On boot, a log line such as `Magnetometer: VCM5883L @ 0x0c` shows which mag was detected. Raw X/Y/Z print in the usual loop.

### Barometer (BMP085 or BMP280)

Same bus. Firmware probes **`0x77`**, then **`0x76`**. **BMP280** chip id is **`0x58`** at register **`0xD0`**; **BMP085** uses **`0x55`** at **`0xD0`**. When a BMP280 is found, the serial loop prints **temperature (°C)** and **pressure (hPa)**.

## 7-bit I2C addresses (same bus)

| Sensor     | Address                                                                       |
|------------|-------------------------------------------------------------------------------|
| ADXL345    | `0x53` (fallback `0x1D` if SDO strapped the other way; firmware tries both)   |
| ITG-3200   | `0x68`                                                                        |
| HMC5883L   | `0x1E`                                                                        |
| LIS3MDL    | `0x1E` or `0x1C`                                                              |
| QMC5883L   | `0x0D` (clone / alternate board; firmware auto-detects)                       |
| VCM5883L   | `0x0C` (default; factory may use another address)                             |
| AK8963     | `0x0C` / `0x0D`                                                               |
| BMP085     | `0x77`                                                                        |
| BMP280     | `0x77` or `0x76` (SDO strap per Bosch BST-BMP280-DS001)                       |

## Changing pins

Edit `main/sen0140_10dof.h`:

```c
#define SEN0140_I2C_SDA_GPIO    10
#define SEN0140_I2C_SCL_GPIO    11
```

Pick GPIOs that are free on your specific dev board and not used for flash/PSRAM straps if applicable.
