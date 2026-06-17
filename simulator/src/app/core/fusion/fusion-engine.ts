import type { AlgorithmConfig, FusionAlgorithmId } from "../models/simulation-config";
import type {
  FusionEstimate,
  GpsMeasurement,
  LoraMarkStatus,
  MarkTruth,
  OcsRisk,
  UwbMeasurement,
  Vec2,
} from "../models/simulation-state";
import {
  distance,
  lineMetrics,
  timeToLineSec,
  trilaterate2d,
  vecUnitFromCourse,
} from "../geo/geometry";
import { BoatEkf } from "./ekf-fusion";

export interface FusionContext {
  boatId: number;
  marks: MarkTruth;
  gps: GpsMeasurement | null;
  uwb: UwbMeasurement | null;
  lora: LoraMarkStatus[];
  velocity: Vec2;
  simTimeSec: number;
  startSignalSec: number;
  config: AlgorithmConfig;
  /** EKF persistent state (required when algorithm is ekf). */
  ekf?: BoatEkf;
  /** Seconds since last EKF predict/update. */
  dtSec?: number;
  gpsNoiseM?: number;
  uwbNoiseM?: number;
  /** When false, EKF returns current state without predict/update. */
  applySensors?: boolean;
}

function velocityFromGps(gps: GpsMeasurement | null): Vec2 {
  if (!gps) {
    return { eastM: 0, northM: 0 };
  }
  const u = vecUnitFromCourse(gps.courseDeg);
  return { eastM: u.eastM * gps.speedMps, northM: u.northM * gps.speedMps };
}

function ocsRisk(
  distM: number,
  ttlSec: number | null,
  startSignalSec: number,
  simTimeSec: number,
): OcsRisk {
  if (ttlSec === null) {
    return "SAFE";
  }
  const projected = distM;
  const timeToSignal = startSignalSec - simTimeSec;
  if (timeToSignal <= 0) {
    return distM < 0 ? "OCS" : "SAFE";
  }
  if (ttlSec < timeToSignal) {
    const margin = distM - (timeToSignal - ttlSec);
    if (margin < -2) {
      return "OCS";
    }
    if (margin < 2) {
      return "MARGINAL";
    }
  }
  return projected < 5 && ttlSec < timeToSignal + 5 ? "MARGINAL" : "SAFE";
}

function computeEstimate(
  position: Vec2,
  marks: MarkTruth,
  velocity: Vec2,
  ctx: FusionContext,
  confidence: number,
  algorithmId: FusionAlgorithmId,
): FusionEstimate {
  const lm = lineMetrics(position, marks.port, marks.starboard, velocity);
  const ttl = timeToLineSec(lm.distanceToLineM, lm.closingSpeedMps);
  const dPort = distance(position, marks.port);
  const dStar = distance(position, marks.starboard);
  const timeToSignal = ctx.startSignalSec - ctx.simTimeSec;
  let undershoot: number | null = null;
  let overshoot: number | null = null;
  if (ttl !== null && timeToSignal > 0) {
    const delta = timeToSignal - ttl;
    const along = lm.signedAlongTrackM + delta * lm.closingSpeedMps;
    if (along < 0) {
      undershoot = Math.abs(along);
    } else {
      overshoot = along;
    }
  }
  return {
    boatId: ctx.boatId,
    position,
    distanceToLineM: lm.distanceToLineM,
    crossTrackM: lm.crossTrackM,
    distancePortM: dPort,
    distanceStarboardM: dStar,
    timeToLineSec: ttl,
    undershootM: undershoot,
    overshootM: overshoot,
    ocsRisk: ocsRisk(lm.distanceToLineM, ttl, ctx.startSignalSec, ctx.simTimeSec),
    confidence,
    algorithmId,
  };
}

export function runFusion(ctx: FusionContext, algorithmId?: FusionAlgorithmId): FusionEstimate {
  const algo = algorithmId ?? ctx.config.algorithmId;
  const vel = velocityFromGps(ctx.gps);
  const v = ctx.velocity.eastM !== 0 || ctx.velocity.northM !== 0 ? ctx.velocity : vel;

  if (algo === "ekf") {
    if (!ctx.ekf) {
      const pos = ctx.gps?.position ?? { eastM: 0, northM: 0 };
      return computeEstimate(pos, ctx.marks, v, ctx, 0.1, algo);
    }
    const dt = ctx.dtSec ?? 0.1;
    const processNoise = Math.max(0.01, ctx.config.smoothing);
    if (ctx.applySensors) {
      ctx.ekf.predict(dt, processNoise);
      if (ctx.gps) {
        ctx.ekf.updateGps(ctx.gps.position, ctx.gpsNoiseM ?? 2);
      }
      if (ctx.uwb?.dPortM != null) {
        ctx.ekf.updateRange(ctx.marks.port, ctx.uwb.dPortM, ctx.uwbNoiseM ?? 0.1);
      }
      if (ctx.uwb?.dStarboardM != null) {
        ctx.ekf.updateRange(
          ctx.marks.starboard,
          ctx.uwb.dStarboardM,
          ctx.uwbNoiseM ?? 0.1,
        );
      }
    }
    const pos = ctx.ekf.getPosition();
    const ekfVel = ctx.ekf.getVelocity();
    const velUse =
      Math.hypot(ekfVel.eastM, ekfVel.northM) > 0.05 ? ekfVel : v;
    let confidence = ctx.ekf.confidence();
    const freshLora = ctx.lora.some(
      (m) => ctx.simTimeSec - m.receivedSec < ctx.config.loraStaleSec,
    );
    if (freshLora) {
      confidence = Math.min(0.98, confidence + 0.05);
    }
    return computeEstimate(pos, ctx.marks, velUse, ctx, confidence, algo);
  }

  if (algo === "gps_only" || !ctx.gps) {
    const pos = ctx.gps?.position ?? { eastM: 0, northM: 0 };
    return computeEstimate(pos, ctx.marks, v, ctx, ctx.gps ? 0.55 : 0.1, algo);
  }

  if (algo === "uwb_trilateration") {
    if (ctx.uwb?.dPortM != null && ctx.uwb.dStarboardM != null && ctx.gps) {
      const pos = trilaterate2d(
        ctx.gps.position,
        ctx.marks.port,
        ctx.marks.starboard,
        ctx.uwb.dPortM,
        ctx.uwb.dStarboardM,
      );
      return computeEstimate(pos, ctx.marks, v, ctx, 0.75, algo);
    }
    return computeEstimate(ctx.gps.position, ctx.marks, v, ctx, 0.35, algo);
  }

  // weighted_gps_uwb
  let pos = ctx.gps.position;
  let confidence = 0.5;
  if (ctx.uwb?.dPortM != null && ctx.uwb.dStarboardM != null) {
    const uwbPos = trilaterate2d(
      ctx.gps.position,
      ctx.marks.port,
      ctx.marks.starboard,
      ctx.uwb.dPortM,
      ctx.uwb.dStarboardM,
    );
    const gw = ctx.config.gpsWeight;
    const uw = ctx.config.uwbWeight;
    const wSum = gw + uw;
    pos = {
      eastM: (ctx.gps.position.eastM * gw + uwbPos.eastM * uw) / wSum,
      northM: (ctx.gps.position.northM * gw + uwbPos.northM * uw) / wSum,
    };
    confidence = Math.min(0.95, 0.5 + uw / wSum);
  }
  const freshLora = ctx.lora.some(
    (m) => ctx.simTimeSec - m.receivedSec < ctx.config.loraStaleSec,
  );
  if (freshLora) {
    confidence = Math.min(0.98, confidence + 0.05);
  }
  return computeEstimate(pos, ctx.marks, v, ctx, confidence, algo);
}
