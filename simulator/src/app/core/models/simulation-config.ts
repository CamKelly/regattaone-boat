/** UWB scheduling strategy (Simulator.pdf §6). */
export type UwbSchedulingMode = "fixed_priority" | "dynamic_priority" | "tdma" | "round_robin";

/** Fusion algorithm variant for comparison runs. */
export type FusionAlgorithmId =
  | "gps_only"
  | "uwb_trilateration"
  | "weighted_gps_uwb"
  | "ekf";

export const ALL_FUSION_ALGORITHMS: FusionAlgorithmId[] = [
  "gps_only",
  "uwb_trilateration",
  "weighted_gps_uwb",
  "ekf",
];

export const FUSION_ALGORITHM_META: Record<
  FusionAlgorithmId,
  { label: string; color: string }
> = {
  gps_only: { label: "GPS only", color: "#1890ff" },
  uwb_trilateration: { label: "UWB trilateration", color: "#fa8c16" },
  weighted_gps_uwb: { label: "Weighted GPS+UWB", color: "#52c41a" },
  ekf: { label: "EKF", color: "#eb2f96" },
};

export interface GpsErrorConfig {
  positionNoiseM: number;
  driftMPerMin: number;
  updateHz: number;
}

export interface UwbErrorConfig {
  noiseM: number;
  dropoutRate: number;
  updateHz: number;
}

export interface LoraConfig {
  packetLoss: number;
  latencySec: number;
  updateHz: number;
}

export interface StartLineConfig {
  /** True line length (m) between marks. */
  lineLengthM: number;
  /** Bearing of line from port → starboard (deg true). */
  bearingDeg: number;
  /** Midpoint easting (m) in local ENU. */
  midEastM: number;
  /** Midpoint northing (m) in local ENU. */
  midNorthM: number;
  markDriftMPerMin: number;
  gpsMarkNoiseM: number;
}

export interface BoatDynamicsConfig {
  count: number;
  startEastM: number;
  startNorthM: number;
  speedKnots: number;
  courseDeg: number;
  accelerationKnotsPerMin: number;
}

export interface AlgorithmConfig {
  algorithmId: FusionAlgorithmId;
  gpsWeight: number;
  uwbWeight: number;
  loraStaleSec: number;
  smoothing: number;
  confidenceThreshold: number;
  uwbScheduling: UwbSchedulingMode;
}

export interface ScenarioMeta {
  id: string;
  label: string;
  description: string;
  seed: number;
}

export interface SimulationConfig {
  scenario: ScenarioMeta;
  startLine: StartLineConfig;
  boat: BoatDynamicsConfig;
  gps: GpsErrorConfig;
  uwb: UwbErrorConfig;
  lora: LoraConfig;
  algorithm: AlgorithmConfig;
  /** Simulation clock speed multiplier (1 = real-time wall clock). */
  timeScale: number;
  /** Seconds until race start signal (sim time). */
  startSignalSec: number;
  /** Map origin for display (lat/lon of ENU 0,0). */
  mapOriginLat: number;
  mapOriginLon: number;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  scenario: {
    id: "straight_approach",
    label: "Straight-line approach",
    description: "Single boat approaching midpoint at steady SOG/COG.",
    seed: 42,
  },
  startLine: {
    lineLengthM: 100,
    bearingDeg: 90,
    midEastM: 0,
    midNorthM: 0,
    markDriftMPerMin: 0,
    gpsMarkNoiseM: 2,
  },
  boat: {
    count: 1,
    startEastM: -80,
    startNorthM: 150,
    speedKnots: 5,
    courseDeg: 180,
    accelerationKnotsPerMin: 0,
  },
  gps: {
    positionNoiseM: 2,
    driftMPerMin: 0.5,
    updateHz: 1,
  },
  uwb: {
    noiseM: 0.1,
    dropoutRate: 0.05,
    updateHz: 5,
  },
  lora: {
    packetLoss: 0.1,
    latencySec: 1,
    updateHz: 0.2,
  },
  algorithm: {
    algorithmId: "ekf",
    gpsWeight: 0.4,
    uwbWeight: 0.6,
    loraStaleSec: 30,
    smoothing: 0.3,
    confidenceThreshold: 0.7,
    uwbScheduling: "fixed_priority",
  },
  timeScale: 1,
  startSignalSec: 300,
  mapOriginLat: 37.7749,
  mapOriginLon: -122.4194,
};

export const PRESET_SCENARIOS: ScenarioMeta[] = [
  DEFAULT_SIMULATION_CONFIG.scenario,
  {
    id: "fast_approach",
    label: "Fast approach",
    description: "Higher SOG toward the line.",
    seed: 101,
  },
  {
    id: "slow_approach",
    label: "Slow approach",
    description: "Low SOG with higher GPS noise.",
    seed: 202,
  },
  {
    id: "port_end",
    label: "Port-end approach",
    description: "Boat targets the port end of the line.",
    seed: 303,
  },
  {
    id: "lora_congestion",
    label: "LoRa congestion",
    description: "High packet loss and latency on mark broadcasts.",
    seed: 404,
  },
  {
    id: "uwb_dropout",
    label: "UWB packet loss",
    description: "Elevated UWB dropout near the line.",
    seed: 505,
  },
];
