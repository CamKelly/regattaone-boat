# Vendored: dw3000-decadriver-source

Full source copy for offline use and long-term maintenance if the upstream repo goes away.

| Field | Value |
|-------|-------|
| Upstream | https://github.com/br101/dw3000-decadriver-source |
| Vendored | 2026-06-23 |
| ESP-IDF component | `platform/esp-idf/decadriver/` (component name: `decadriver`) |

## Licenses

- **Platform / ESP-IDF port** — ISC (`LICENSE.txt` in this tree)
- **Qorvo `dwt_uwb_driver/`** — [LicenseRef-QORVO-2](dwt_uwb_driver/LICENSES/LicenseRef-QORVO-2.txt)

## Local patches (RegattaOne)

- `platform/esp-idf/decadriver/CMakeLists.txt` — `esp_driver_spi` / `esp_driver_gpio` for ESP-IDF 6.x
- `platform/esp-idf/decadriver/dw3000_spi.c` — include `esp_intr_alloc.h` and `freertos/FreeRTOS.h` (IDF 6.x)

## Refresh from upstream

```bash
rm -rf components/dw3000-decadriver-source
git clone --depth 1 https://github.com/br101/dw3000-decadriver-source.git components/dw3000-decadriver-source
rm -rf components/dw3000-decadriver-source/.git
# Re-apply patches listed above, update this file.
```
