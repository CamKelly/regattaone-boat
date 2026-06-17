import type { FusionAlgorithmId, SimulationConfig } from "../models/simulation-config";
import { ALL_FUSION_ALGORITHMS } from "../models/simulation-config";
import type {
  BoatTruth,
  FusionEstimate,
  GpsMeasurement,
  LoraMarkStatus,
  MarkTruth,
  RunSummary,
  ScoringSample,
  SimulationSnapshot,
  TruthMetrics,
  UwbMeasurement,
  Vec2,
} from "../models/simulation-state";
import { SeededRng } from "../rng";
import {
  distance,
  knotsToMps,
  lineMetrics,
  marksFromLineConfig,
  timeToLineSec,
  vecAdd,
  vecScale,
  vecUnitFromCourse,
} from "../geo/geometry";
import { BoatEkf } from "../fusion/ekf-fusion";
import { runFusion } from "../fusion/fusion-engine";

const TICK_HZ = 10;

export class SimulationEngine {
  private rng: SeededRng;
  private config: SimulationConfig;
  private simTimeSec = 0;
  private running = false;
  private boats: BoatTruth[] = [];
  private marks: MarkTruth = { port: { eastM: 0, northM: 0 }, starboard: { eastM: 0, northM: 0 } };
  private markDriftPhase = 0;
  private lastGps: GpsMeasurement[] = [];
  private lastUwb: UwbMeasurement[] = [];
  private lastLora: LoraMarkStatus[] = [];
  private scoring: ScoringSample[] = [];
  private uwbAttempts = 0;
  private uwbHits = 0;
  private loraAttempts = 0;
  private loraHits = 0;
  private nextGpsTick = 0;
  private nextUwbTick = 0;
  private nextLoraTick = 0;
  private recordScoring = false;
  private lastStepDtSec = 0.1;
  private ekfByBoat: BoatEkf[] = [];

  constructor(config: SimulationConfig) {
    this.config = structuredClone(config);
    this.rng = new SeededRng(config.scenario.seed);
    this.reset();
  }

  setConfig(config: SimulationConfig, resetState = true): void {
    this.config = structuredClone(config);
    if (resetState) {
      this.reset();
    }
  }

  getConfig(): SimulationConfig {
    return structuredClone(this.config);
  }

  isRunning(): boolean {
    return this.running;
  }

  reset(): void {
    this.rng = new SeededRng(this.config.scenario.seed);
    this.simTimeSec = 0;
    this.running = false;
    this.scoring = [];
    this.uwbAttempts = 0;
    this.uwbHits = 0;
    this.loraAttempts = 0;
    this.loraHits = 0;
    this.nextGpsTick = 0;
    this.nextUwbTick = 0;
    this.nextLoraTick = 0;
    this.markDriftPhase = 0;
    this.initMarks();
    this.initBoats();
    this.lastGps = [];
    this.lastUwb = [];
    this.lastLora = [];
  }

  start(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  step(dtSec: number): SimulationSnapshot {
    this.lastStepDtSec = dtSec;
    if (this.running) {
      this.simTimeSec += dtSec;
      this.advanceTruth(dtSec);
      this.sampleSensors();
      this.recordScoring = true;
    }
    const snap = this.snapshot();
    this.recordScoring = false;
    return snap;
  }

  private initMarks(): void {
    const m = marksFromLineConfig(
      this.config.startLine.midEastM,
      this.config.startLine.midNorthM,
      this.config.startLine.lineLengthM,
      this.config.startLine.bearingDeg,
    );
    this.marks = { port: { ...m.port }, starboard: { ...m.starboard } };
  }

  private initBoats(): void {
    const { boat } = this.config;
    this.boats = [];
    this.ekfByBoat = [];
    for (let i = 0; i < boat.count; i++) {
      const offset = i * 15;
      const position = { eastM: boat.startEastM + offset, northM: boat.startNorthM };
      const speedMps = knotsToMps(boat.speedKnots);
      const u = vecUnitFromCourse(boat.courseDeg);
      this.boats.push({
        id: i,
        position,
        speedMps,
        courseDeg: boat.courseDeg,
      });
      const ekf = new BoatEkf();
      ekf.reset(position, { eastM: u.eastM * speedMps, northM: u.northM * speedMps });
      this.ekfByBoat.push(ekf);
    }
  }

  private advanceTruth(dtSec: number): void {
    const drift = (this.config.startLine.markDriftMPerMin / 60) * dtSec;
    this.markDriftPhase += dtSec;
    const driftVec = {
      eastM: Math.sin(this.markDriftPhase * 0.02) * drift,
      northM: Math.cos(this.markDriftPhase * 0.015) * drift,
    };
    this.marks.port = vecAdd(this.marks.port, driftVec);
    this.marks.starboard = vecAdd(this.marks.starboard, driftVec);

    const accel = knotsToMps(this.config.boat.accelerationKnotsPerMin) / 60;
    for (const b of this.boats) {
      b.speedMps = Math.max(0, b.speedMps + accel * dtSec);
      const u = vecUnitFromCourse(b.courseDeg);
      b.position = vecAdd(b.position, vecScale(u, b.speedMps * dtSec));
    }
  }

  private uwbRateHz(boat: BoatTruth): number {
    const lm = lineMetrics(boat.position, this.marks.port, this.marks.starboard, {
      eastM: 0,
      northM: 0,
    });
    const d = lm.distanceToLineM;
    if (d < 25) {
      return 10;
    }
    if (d < 50) {
      return 5;
    }
    if (d < 100) {
      return 2;
    }
    return 1;
  }

  private sampleSensors(): void {
    const t = this.simTimeSec;
    const cfg = this.config;

    if (t >= this.nextGpsTick) {
      this.lastGps = this.boats.map((b) => ({
        boatId: b.id,
        position: {
          eastM: b.position.eastM + this.rng.gaussian(0, cfg.gps.positionNoiseM),
          northM: b.position.northM + this.rng.gaussian(0, cfg.gps.positionNoiseM),
        },
        speedMps: b.speedMps + this.rng.gaussian(0, knotsToMps(0.05)),
        courseDeg: b.courseDeg + this.rng.gaussian(0, 2),
        timestampSec: t,
      }));
      this.nextGpsTick = t + 1 / Math.max(cfg.gps.updateHz, 0.1);
    }

    if (t >= this.nextUwbTick) {
      this.lastUwb = this.boats.map((b) => {
        this.uwbAttempts++;
        const rate = this.uwbRateHz(b);
        if (!this.rng.chance(Math.min(1, rate / Math.max(cfg.uwb.updateHz, 0.1)))) {
          return { boatId: b.id, dPortM: null, dStarboardM: null, timestampSec: t };
        }
        if (this.rng.chance(cfg.uwb.dropoutRate)) {
          return { boatId: b.id, dPortM: null, dStarboardM: null, timestampSec: t };
        }
        this.uwbHits++;
        const n = cfg.uwb.noiseM;
        return {
          boatId: b.id,
          dPortM: distance(b.position, this.marks.port) + this.rng.gaussian(0, n),
          dStarboardM: distance(b.position, this.marks.starboard) + this.rng.gaussian(0, n),
          timestampSec: t,
        };
      });
      this.nextUwbTick = t + 1 / Math.max(cfg.uwb.updateHz, 0.1);
    }

    if (t >= this.nextLoraTick) {
      this.loraAttempts++;
      if (!this.rng.chance(cfg.lora.packetLoss)) {
        this.loraHits++;
        const n = cfg.startLine.gpsMarkNoiseM;
        const dPs =
          distance(this.marks.port, this.marks.starboard) + this.rng.gaussian(0, n);
        const dSp =
          distance(this.marks.starboard, this.marks.port) + this.rng.gaussian(0, n);
        const sent = t;
        const received = t + cfg.lora.latencySec;
        this.lastLora = [
          {
            markId: "port",
            position: {
              eastM: this.marks.port.eastM + this.rng.gaussian(0, n),
              northM: this.marks.port.northM + this.rng.gaussian(0, n),
            },
            dPsM: dPs,
            dSpM: dSp,
            timestampSec: sent,
            receivedSec: received,
          },
          {
            markId: "starboard",
            position: {
              eastM: this.marks.starboard.eastM + this.rng.gaussian(0, n),
              northM: this.marks.starboard.northM + this.rng.gaussian(0, n),
            },
            dPsM: dPs,
            dSpM: dSp,
            timestampSec: sent,
            receivedSec: received,
          },
        ];
      } else {
        this.lastLora = [];
      }
      this.nextLoraTick = t + 1 / Math.max(cfg.lora.updateHz, 0.01);
    }
  }

  private truthMetrics(): TruthMetrics[] {
    return this.boats.map((b) => {
      const u = vecUnitFromCourse(b.courseDeg);
      const vel: Vec2 = { eastM: u.eastM * b.speedMps, northM: u.northM * b.speedMps };
      const lm = lineMetrics(b.position, this.marks.port, this.marks.starboard, vel);
      return {
        boatId: b.id,
        distanceToLineM: lm.distanceToLineM,
        timeToLineSec: timeToLineSec(lm.distanceToLineM, lm.closingSpeedMps),
        crossTrackM: lm.crossTrackM,
      };
    });
  }

  private buildSummary(): RunSummary {
    const distErrors = this.scoring.map((s) => Math.abs(s.distanceErrorM));
    const timeErrors = this.scoring
      .map((s) => s.timeToLineErrorSec)
      .filter((x): x is number => x !== null);
    const sorted = [...distErrors].sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      : 0;
    return {
      meanDistanceErrorM: distErrors.length
        ? distErrors.reduce((a, b) => a + b, 0) / distErrors.length
        : 0,
      p95DistanceErrorM: p95,
      maxDistanceErrorM: distErrors.length ? Math.max(...distErrors) : 0,
      meanTimeErrorSec: timeErrors.length
        ? timeErrors.reduce((a, b) => a + b, 0) / timeErrors.length
        : null,
      ocsPredictionAccuracy: null,
      uwbAvailability: this.uwbAttempts ? this.uwbHits / this.uwbAttempts : 0,
      loraDelivery: this.loraAttempts ? this.loraHits / this.loraAttempts : 0,
    };
  }

  snapshot(): SimulationSnapshot {
    const truthM = this.truthMetrics();
    const fusionByAlgorithm = {} as Record<FusionAlgorithmId, FusionEstimate[]>;

    for (const algo of ALL_FUSION_ALGORITHMS) {
      fusionByAlgorithm[algo] = this.boats.map((b) => {
        const u = vecUnitFromCourse(b.courseDeg);
        const vel: Vec2 = { eastM: u.eastM * b.speedMps, northM: u.northM * b.speedMps };
        return runFusion(
          {
            boatId: b.id,
            marks: this.marks,
            gps: this.lastGps.find((g) => g.boatId === b.id) ?? null,
            uwb: this.lastUwb.find((uw) => uw.boatId === b.id) ?? null,
            lora: this.lastLora,
            velocity: vel,
            simTimeSec: this.simTimeSec,
            startSignalSec: this.config.startSignalSec,
            config: this.config.algorithm,
            ekf: this.ekfByBoat[b.id],
            dtSec: this.lastStepDtSec,
            gpsNoiseM: this.config.gps.positionNoiseM,
            uwbNoiseM: this.config.uwb.noiseM,
            applySensors: this.recordScoring,
          },
          algo,
        );
      });
    }

    const primaryId = this.config.algorithm.algorithmId;
    const fusion = fusionByAlgorithm[primaryId] ?? [];

    if (this.recordScoring) {
      for (const f of fusion) {
        const truth = truthM.find((t) => t.boatId === f.boatId);
        if (!truth) {
          continue;
        }
        const sample: ScoringSample = {
          simTimeSec: this.simTimeSec,
          distanceErrorM: f.distanceToLineM - truth.distanceToLineM,
          timeToLineErrorSec:
            f.timeToLineSec !== null && truth.timeToLineSec !== null
              ? f.timeToLineSec - truth.timeToLineSec
              : null,
          confidence: f.confidence,
        };
        this.scoring.push(sample);
        if (this.scoring.length > 5000) {
          this.scoring.shift();
        }
      }
    }

    return {
      simTimeSec: this.simTimeSec,
      truth: { marks: { ...this.marks }, boats: this.boats.map((b) => ({ ...b })) },
      sensors: {
        gps: [...this.lastGps],
        uwb: [...this.lastUwb],
        lora: [...this.lastLora],
      },
      fusion,
      fusionByAlgorithm,
      truthMetrics: truthM,
      scoring: [...this.scoring],
      summary: this.buildSummary(),
      running: this.running,
    };
  }

  static tickIntervalMs(): number {
    return 1000 / TICK_HZ;
  }
}
