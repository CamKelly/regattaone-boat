# Start Line Fusion Simulator

Browser-based simulator for tuning the regatta start-line fusion algorithm before porting it to the ESP32-S3 firmware. See `../Simulator.pdf` for the full product spec.

## Stack

- Angular 19 (standalone components)
- RxJS (`BehaviorSubject` + interval tick loop)
- [ng-zorro-antd](https://ng.ant.design/) (Ant Design)
- [OpenLayers](https://openlayers.org/) map view

## Quick start

```bash
cd simulator
npm install
npm start
```

Open [http://localhost:5180](http://localhost:5180).

## Layout

| Panel | Purpose |
|-------|---------|
| Map | Truth marks/boat, GPS fixes, LoRa mark estimates, fusion position, start line |
| Controls | Live sliders for GPS/UWB/LoRa noise, fusion weights, boat dynamics, time scale |
| Charts | Distance-to-line and time-to-line vs sim time |
| Metrics | Live fusion output, OCS risk, rolling run summary |

Use **Run / Pause / Step / Reset** and preset scenarios from the toolbar. Parameter changes apply without resetting the run so you can tune weights mid-simulation.

## Core engine (`src/app/core/`)

- `simulation/simulation-engine.ts` — 10 Hz truth model, sensor sampling, scoring
- `fusion/fusion-engine.ts` — `gps_only`, `uwb_trilateration`, `weighted_gps_uwb`
- `geo/geometry.ts` — ENU math, line metrics, trilateration
- `rng.ts` — seeded Mulberry32 for reproducible scenarios

## Not yet implemented (from PDF)

- Multi-boat fleet view
- Monte Carlo batch runs / scorecard export

## Fusion algorithms

All four run in parallel every tick:

| ID | Description |
|----|-------------|
| `gps_only` | Raw GPS position |
| `uwb_trilateration` | GPS prior + two UWB ranges |
| `weighted_gps_uwb` | Weighted blend of GPS and UWB fix |
| `ekf` | 4-state constant-velocity EKF (GPS + UWB range updates) — **default primary** |

Use the **chart overlay toggles** to show/hide each series. The **Primary** dropdown selects which algorithm drives the live metrics summary.
