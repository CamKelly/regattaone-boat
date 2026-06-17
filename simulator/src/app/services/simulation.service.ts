import { Injectable, OnDestroy } from "@angular/core";
import { BehaviorSubject, Subscription, interval } from "rxjs";
import {
  ALL_FUSION_ALGORITHMS,
  DEFAULT_SIMULATION_CONFIG,
  FUSION_ALGORITHM_META,
  PRESET_SCENARIOS,
  type FusionAlgorithmId,
  type ScenarioMeta,
  type SimulationConfig,
} from "../core/models/simulation-config";
import type {
  AlgorithmChartVisibility,
  ChartHistoryPoint,
  SimulationSnapshot,
} from "../core/models/simulation-state";
import { DEFAULT_CHART_VISIBILITY } from "../core/models/simulation-state";
import { SimulationEngine } from "../core/simulation/simulation-engine";

export { FUSION_ALGORITHM_META, ALL_FUSION_ALGORITHMS };

@Injectable({ providedIn: "root" })
export class SimulationService implements OnDestroy {
  private engine = new SimulationEngine(DEFAULT_SIMULATION_CONFIG);
  private tickSub: Subscription | null = null;

  private readonly configSubject = new BehaviorSubject<SimulationConfig>(
    DEFAULT_SIMULATION_CONFIG,
  );
  private readonly snapshotSubject = new BehaviorSubject<SimulationSnapshot>(
    this.engine.snapshot(),
  );
  private readonly chartHistorySubject = new BehaviorSubject<ChartHistoryPoint[]>([]);
  private readonly chartVisibilitySubject = new BehaviorSubject<AlgorithmChartVisibility>(
    structuredClone(DEFAULT_CHART_VISIBILITY),
  );

  readonly config$ = this.configSubject.asObservable();
  readonly snapshot$ = this.snapshotSubject.asObservable();
  readonly chartHistory$ = this.chartHistorySubject.asObservable();
  readonly chartVisibility$ = this.chartVisibilitySubject.asObservable();

  constructor() {
    this.emitSnapshot();
  }

  ngOnDestroy(): void {
    this.stopTicking();
  }

  getConfig(): SimulationConfig {
    return this.configSubject.value;
  }

  getSnapshot(): SimulationSnapshot {
    return this.snapshotSubject.value;
  }

  getChartVisibility(): AlgorithmChartVisibility {
    return this.chartVisibilitySubject.value;
  }

  setChartVisibility(patch: Partial<AlgorithmChartVisibility>): void {
    this.chartVisibilitySubject.next({
      ...this.chartVisibilitySubject.value,
      ...patch,
    });
  }

  isAlgorithmVisible(id: FusionAlgorithmId | "truth"): boolean {
    return this.chartVisibilitySubject.value[id];
  }

  updateConfig(patch: Partial<SimulationConfig>): void {
    const next = { ...structuredClone(this.configSubject.value), ...patch };
    this.configSubject.next(next);
    this.engine.setConfig(next);
    this.emitSnapshot();
  }

  updateConfigSection<K extends keyof SimulationConfig>(
    key: K,
    value: SimulationConfig[K],
    resetState = false,
  ): void {
    const next = structuredClone(this.configSubject.value);
    next[key] = value;
    this.configSubject.next(next);
    this.engine.setConfig(next, resetState);
    this.emitSnapshot();
  }

  applyScenario(scenario: ScenarioMeta): void {
    const base = structuredClone(this.configSubject.value);
    base.scenario = scenario;
    this.applyScenarioOverrides(base, scenario.id);
    this.configSubject.next(base);
    this.engine.setConfig(base);
    this.chartHistorySubject.next([]);
    this.emitSnapshot();
  }

  private applyScenarioOverrides(config: SimulationConfig, id: string): void {
    switch (id) {
      case "fast_approach":
        config.boat.speedKnots = 8;
        config.boat.courseDeg = 180;
        break;
      case "slow_approach":
        config.boat.speedKnots = 2;
        config.gps.positionNoiseM = 4;
        break;
      case "port_end":
        config.boat.startEastM =
          config.startLine.midEastM - config.startLine.lineLengthM / 2 - 60;
        config.boat.courseDeg = 90;
        break;
      case "lora_congestion":
        config.lora.packetLoss = 0.4;
        config.lora.latencySec = 5;
        break;
      case "uwb_dropout":
        config.uwb.dropoutRate = 0.35;
        break;
      default:
        break;
    }
  }

  reset(): void {
    this.engine.setConfig(this.configSubject.value);
    this.engine.reset();
    this.chartHistorySubject.next([]);
    this.emitSnapshot();
  }

  start(): void {
    this.engine.start();
    this.startTicking();
    this.emitSnapshot();
  }

  pause(): void {
    this.engine.pause();
    this.stopTicking();
    this.emitSnapshot();
  }

  stepOnce(): void {
    const wasRunning = this.engine.isRunning();
    if (!wasRunning) {
      this.engine.start();
    }
    const dt = (1 / 10) * this.configSubject.value.timeScale;
    this.publishStep(this.engine.step(dt));
    if (!wasRunning) {
      this.engine.pause();
    }
  }

  listScenarios(): ScenarioMeta[] {
    return PRESET_SCENARIOS;
  }

  private startTicking(): void {
    this.stopTicking();
    this.tickSub = interval(SimulationEngine.tickIntervalMs()).subscribe(() => {
      const dt = (1 / 10) * this.configSubject.value.timeScale;
      this.publishStep(this.engine.step(dt));
    });
  }

  private stopTicking(): void {
    this.tickSub?.unsubscribe();
    this.tickSub = null;
  }

  private publishStep(snap: SimulationSnapshot): void {
    this.snapshotSubject.next(snap);
    if (snap.running) {
      this.appendChartPoint(snap);
    }
  }

  private emitSnapshot(): void {
    this.snapshotSubject.next(this.engine.snapshot());
  }

  private appendChartPoint(snap: SimulationSnapshot): void {
    const boatId = 0;
    const truth = snap.truthMetrics.find((t) => t.boatId === boatId);
    if (!truth) {
      return;
    }

    const byAlgorithm: ChartHistoryPoint["byAlgorithm"] = {};
    for (const algo of ALL_FUSION_ALGORITHMS) {
      const est = snap.fusionByAlgorithm[algo]?.find((f) => f.boatId === boatId);
      if (!est) {
        continue;
      }
      byAlgorithm[algo] = {
        distanceM: est.distanceToLineM,
        ttlSec: est.timeToLineSec,
        distanceErrorM: est.distanceToLineM - truth.distanceToLineM,
        timeErrorSec:
          est.timeToLineSec !== null && truth.timeToLineSec !== null
            ? est.timeToLineSec - truth.timeToLineSec
            : null,
      };
    }

    const history = [...this.chartHistorySubject.value];
    history.push({
      simTimeSec: snap.simTimeSec,
      truthDistanceM: truth.distanceToLineM,
      truthTtlSec: truth.timeToLineSec,
      byAlgorithm,
    });
    if (history.length > 2000) {
      history.shift();
    }
    this.chartHistorySubject.next(history);
  }
}
