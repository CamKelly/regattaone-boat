import type { FusionAlgorithmId } from "./simulation-config";

export interface Vec2 {
  eastM: number;
  northM: number;
}

export interface BoatTruth {
  id: number;
  position: Vec2;
  speedMps: number;
  courseDeg: number;
}

export interface MarkTruth {
  port: Vec2;
  starboard: Vec2;
}

export interface GpsMeasurement {
  boatId: number;
  position: Vec2;
  speedMps: number;
  courseDeg: number;
  timestampSec: number;
}

export interface UwbMeasurement {
  boatId: number;
  dPortM: number | null;
  dStarboardM: number | null;
  timestampSec: number;
}

export interface LoraMarkStatus {
  markId: "port" | "starboard";
  position: Vec2;
  dPsM: number | null;
  dSpM: number | null;
  timestampSec: number;
  receivedSec: number;
}

export type OcsRisk = "SAFE" | "MARGINAL" | "OCS";

export interface FusionEstimate {
  boatId: number;
  position: Vec2;
  distanceToLineM: number;
  crossTrackM: number;
  distancePortM: number;
  distanceStarboardM: number;
  timeToLineSec: number | null;
  undershootM: number | null;
  overshootM: number | null;
  ocsRisk: OcsRisk;
  confidence: number;
  algorithmId: FusionAlgorithmId;
}

export interface TruthMetrics {
  boatId: number;
  distanceToLineM: number;
  timeToLineSec: number | null;
  crossTrackM: number;
}

export interface ScoringSample {
  simTimeSec: number;
  distanceErrorM: number;
  timeToLineErrorSec: number | null;
  confidence: number;
}

export interface RunSummary {
  meanDistanceErrorM: number;
  p95DistanceErrorM: number;
  maxDistanceErrorM: number;
  meanTimeErrorSec: number | null;
  ocsPredictionAccuracy: number | null;
  uwbAvailability: number;
  loraDelivery: number;
}

export interface SimulationSnapshot {
  simTimeSec: number;
  truth: {
    marks: MarkTruth;
    boats: BoatTruth[];
  };
  sensors: {
    gps: GpsMeasurement[];
    uwb: UwbMeasurement[];
    lora: LoraMarkStatus[];
  };
  fusion: FusionEstimate[];
  /** All algorithms evaluated in parallel each tick. */
  fusionByAlgorithm: Record<FusionAlgorithmId, FusionEstimate[]>;
  truthMetrics: TruthMetrics[];
  scoring: ScoringSample[];
  summary: RunSummary;
  running: boolean;
}

export interface TimeSeriesPoint {
  t: number;
  truth: number;
  estimate: number;
  error: number;
}

export interface ChartHistoryPoint {
  simTimeSec: number;
  truthDistanceM: number;
  truthTtlSec: number | null;
  byAlgorithm: Partial<
    Record<
      FusionAlgorithmId,
      {
        distanceM: number;
        ttlSec: number | null;
        distanceErrorM: number;
        timeErrorSec: number | null;
      }
    >
  >;
}

export interface AlgorithmChartVisibility {
  truth: boolean;
  gps_only: boolean;
  uwb_trilateration: boolean;
  weighted_gps_uwb: boolean;
  ekf: boolean;
}

export const DEFAULT_CHART_VISIBILITY: AlgorithmChartVisibility = {
  truth: true,
  gps_only: true,
  uwb_trilateration: true,
  weighted_gps_uwb: true,
  ekf: true,
};
