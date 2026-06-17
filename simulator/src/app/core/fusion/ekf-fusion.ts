import type { MarkTruth, Vec2 } from "../models/simulation-state";

/** 4-state ENU filter: [east, north, vEast, vNorth]. */
export class BoatEkf {
  private x = [0, 0, 0, 0];
  private p = [
    25, 0, 0, 0,
    0, 25, 0, 0,
    0, 0, 4, 0,
    0, 0, 0, 4,
  ];

  reset(position: Vec2, velocity: Vec2): void {
    this.x = [position.eastM, position.northM, velocity.eastM, velocity.northM];
    this.p = [
      25, 0, 0, 0,
      0, 25, 0, 0,
      0, 0, 4, 0,
      0, 0, 0, 4,
    ];
  }

  predict(dtSec: number, processNoise: number): void {
    if (dtSec <= 0) {
      return;
    }
    this.x[0] += this.x[2] * dtSec;
    this.x[1] += this.x[3] * dtSec;

    const qPos = processNoise * dtSec * dtSec;
    const qVel = processNoise;
    const f = [
      1, 0, dtSec, 0,
      0, 1, 0, dtSec,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    const fpFt = matMul4(matMul4(f, this.p), transpose4(f));
    fpFt[0] += qPos;
    fpFt[5] += qPos;
    fpFt[10] += qVel;
    fpFt[15] += qVel;
    this.p = fpFt;
  }

  updateGps(position: Vec2, sigmaM: number): void {
    const r = sigmaM * sigmaM;
    const y0 = position.eastM - this.x[0];
    const y1 = position.northM - this.x[1];

    const s00 = this.p[0] + r;
    const s01 = this.p[1];
    const s10 = this.p[4];
    const s11 = this.p[5] + r;
    const det = s00 * s11 - s01 * s10;
    if (Math.abs(det) < 1e-12) {
      return;
    }
    const invDet = 1 / det;
    const is00 = s11 * invDet;
    const is01 = -s01 * invDet;
    const is10 = -s10 * invDet;
    const is11 = s00 * invDet;

    const k = new Array(8).fill(0);
    for (let i = 0; i < 4; i++) {
      const pi0 = this.p[i * 4];
      const pi1 = this.p[i * 4 + 1];
      k[i * 2] = pi0 * is00 + pi1 * is10;
      k[i * 2 + 1] = pi0 * is01 + pi1 * is11;
    }

    for (let i = 0; i < 4; i++) {
      this.x[i] += k[i * 2] * y0 + k[i * 2 + 1] * y1;
    }

    const pNew = [...this.p];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const hp0j = this.p[j];
        const hp1j = this.p[4 + j];
        pNew[i * 4 + j] = this.p[i * 4 + j] - (k[i * 2] * hp0j + k[i * 2 + 1] * hp1j);
      }
    }
    this.p = pNew;
  }

  updateRange(mark: Vec2, rangeM: number, sigmaM: number): void {
    const dx = this.x[0] - mark.eastM;
    const dy = this.x[1] - mark.northM;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) {
      return;
    }
    const innov = rangeM - dist;
    const r = sigmaM * sigmaM;
    const hx = dx / dist;
    const hy = dy / dist;

    let s = r;
    const hp = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) {
      hp[j] = this.p[j] * hx + this.p[4 + j] * hy;
      s += hp[j] * (j < 2 ? (j === 0 ? hx : hy) : 0);
    }
    s = r + hx * hp[0] + hy * hp[1];
    if (s < 1e-12) {
      return;
    }

    const k = hp.map((v) => v / s);
    for (let i = 0; i < 4; i++) {
      this.x[i] += k[i] * innov;
    }
    const pNew = [...this.p];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let hpj = 0;
        for (let t = 0; t < 4; t++) {
          hpj += (t === 0 ? hx : t === 1 ? hy : 0) * this.p[t * 4 + j];
        }
        pNew[i * 4 + j] -= k[i] * hpj;
      }
    }
    this.p = pNew;
  }

  getPosition(): Vec2 {
    return { eastM: this.x[0], northM: this.x[1] };
  }

  getVelocity(): Vec2 {
    return { eastM: this.x[2], northM: this.x[3] };
  }

  confidence(): number {
    const posVar = this.p[0] + this.p[5];
    return Math.max(0.1, Math.min(0.98, 1 / (1 + posVar / 10)));
  }
}

export function runEkfFusionStep(
  ekf: BoatEkf,
  dtSec: number,
  gps: Vec2 | null,
  uwb: { dPortM: number | null; dStarboardM: number | null } | null,
  marks: MarkTruth,
  gpsNoiseM: number,
  uwbNoiseM: number,
  processNoise: number,
): Vec2 {
  ekf.predict(dtSec, processNoise);
  if (gps) {
    ekf.updateGps(gps, gpsNoiseM);
  }
  if (uwb?.dPortM != null) {
    ekf.updateRange(marks.port, uwb.dPortM, uwbNoiseM);
  }
  if (uwb?.dStarboardM != null) {
    ekf.updateRange(marks.starboard, uwb.dStarboardM, uwbNoiseM);
  }
  return ekf.getPosition();
}

function transpose4(m: number[]): number[] {
  return [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
}

function matMul4(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++) {
        out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
      }
    }
  }
  return out;
}
