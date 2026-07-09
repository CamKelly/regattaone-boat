# Vendored: libdeca

Full source copy for offline use and long-term maintenance if the upstream repo
goes away. Provides two-way ranging (TWR) and an 802.15.4 MAC layer on top of the
Qorvo `decadriver` / `dwt_uwb_driver`.

| Field | Value |
|-------|-------|
| Upstream | https://github.com/br101/libdeca |
| Vendored | 2026-07-08 |
| ESP-IDF component | `components/libdeca/` (component name: `libdeca`) |
| Depends on | `decadriver` (see `components/dw3000-decadriver-source`) |

## Licenses

- **libdeca** — GNU Lesser General Public License v3 (`LICENSE.txt` in this tree).

## What we removed from upstream

- `.git/` — vendored as plain source.
- `samples/` — the standalone ESP-IDF TWR demo project (not needed; our
  integration lives in `main/dw3000_ranging.[ch]`).

## Local patches (RegattaOne)

- None. `CMakeLists.txt` is used as-is; the root of this component is registered
  directly as ESP-IDF component `libdeca`, using `platform/esp-idf/` for the
  deferred-IRQ task and `platform/esp-idf/priv/log.h` for logging.

## How it is wired in

- `main/dw3000_ranging.c` is the RegattaOne wrapper: it drives the libdeca init
  sequence (`dwhw_init` → `dwphy_config` → `dwmac_init` → `twr_init`) and exposes
  `dw3000_range_to(addr, &dist_cm, timeout_ms)`.
- Enabled by `CONFIG_DW3000_RANGING_ENABLE` (menu "RegattaOne — DWM3000").

## Refresh from upstream

```bash
rm -rf components/libdeca
git clone --depth 1 https://github.com/br101/libdeca.git components/libdeca
rm -rf components/libdeca/.git components/libdeca/samples
# Re-check platform/esp-idf integration and this file.
```
