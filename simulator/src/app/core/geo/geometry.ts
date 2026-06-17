import type { Vec2 } from "../models/simulation-state";

const KNOTS_TO_MPS = 0.514444;

export function knotsToMps(knots: number): number {
  return knots * KNOTS_TO_MPS;
}

export function mpsToKnots(mps: number): number {
  return mps / KNOTS_TO_MPS;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function vecSub(a: Vec2, b: Vec2): Vec2 {
  return { eastM: a.eastM - b.eastM, northM: a.northM - b.northM };
}

export function vecAdd(a: Vec2, b: Vec2): Vec2 {
  return { eastM: a.eastM + b.eastM, northM: a.northM + b.northM };
}

export function vecLen(v: Vec2): number {
  return Math.hypot(v.eastM, v.northM);
}

export function vecScale(v: Vec2, s: number): Vec2 {
  return { eastM: v.eastM * s, northM: v.northM * s };
}

export function vecUnitFromCourse(courseDeg: number): Vec2 {
  const r = degToRad(courseDeg);
  return { eastM: Math.sin(r), northM: Math.cos(r) };
}

export function distance(a: Vec2, b: Vec2): number {
  return vecLen(vecSub(a, b));
}

/** Port mark at west end, starboard at east end for bearing 90°. */
export function marksFromLineConfig(
  midEastM: number,
  midNorthM: number,
  lineLengthM: number,
  bearingDeg: number,
): { port: Vec2; starboard: Vec2 } {
  const half = lineLengthM / 2;
  const r = degToRad(bearingDeg);
  const along = { eastM: Math.sin(r), northM: Math.cos(r) };
  const mid = { eastM: midEastM, northM: midNorthM };
  return {
    port: vecAdd(mid, vecScale(along, -half)),
    starboard: vecAdd(mid, vecScale(along, half)),
  };
}

export interface LineMetrics {
  distanceToLineM: number;
  crossTrackM: number;
  signedAlongTrackM: number;
  closingSpeedMps: number;
}

/** Signed cross-track: positive = starboard side of line (looking along port→starboard). */
export function lineMetrics(
  boat: Vec2,
  port: Vec2,
  starboard: Vec2,
  velocity: Vec2,
): LineMetrics {
  const line = vecSub(starboard, port);
  const len = vecLen(line);
  if (len < 1e-6) {
    return { distanceToLineM: 0, crossTrackM: 0, signedAlongTrackM: 0, closingSpeedMps: 0 };
  }
  const unit = vecScale(line, 1 / len);
  const normal = { eastM: -unit.northM, northM: unit.eastM };
  const rel = vecSub(boat, port);
  const along = rel.eastM * unit.eastM + rel.northM * unit.northM;
  const cross = rel.eastM * normal.eastM + rel.northM * normal.northM;
  const distanceToLineM = Math.abs(cross);
  const closingSpeedMps = -(velocity.eastM * normal.eastM + velocity.northM * normal.northM);
  return {
    distanceToLineM,
    crossTrackM: cross,
    signedAlongTrackM: along,
    closingSpeedMps: Math.max(0, closingSpeedMps),
  };
}

export function timeToLineSec(distanceM: number, closingMps: number): number | null {
  if (closingMps < 0.05 || distanceM < 0) {
    return null;
  }
  return distanceM / closingMps;
}

/** Simple 2-circle + line constraint position from GPS prior and two UWB ranges. */
export function trilaterate2d(
  prior: Vec2,
  port: Vec2,
  starboard: Vec2,
  dPort: number,
  dStarboard: number,
): Vec2 {
  const wPort = 1 / Math.max(dPort, 1);
  const wStar = 1 / Math.max(dStarboard, 1);
  const towardPort = vecScale(vecSub(port, prior), wPort);
  const towardStar = vecScale(vecSub(starboard, prior), wStar);
  const blended = vecAdd(vecAdd(prior, towardPort), towardStar);
  const scale = 0.5;
  return {
    eastM: prior.eastM * (1 - scale) + blended.eastM * scale,
    northM: prior.northM * (1 - scale) + blended.northM * scale,
  };
}

export function enuToLonLat(
  eastM: number,
  northM: number,
  originLat: number,
  originLon: number,
): [number, number] {
  const latRad = degToRad(originLat);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(latRad);
  const lat = originLat + northM / mPerDegLat;
  const lon = originLon + eastM / mPerDegLon;
  return [lon, lat];
}
