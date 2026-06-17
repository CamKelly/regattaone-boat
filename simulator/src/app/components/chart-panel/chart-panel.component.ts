import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
} from "@angular/core";
import { combineLatest, Subscription } from "rxjs";
import { NzCardModule } from "ng-zorro-antd/card";
import { NzCheckboxModule } from "ng-zorro-antd/checkbox";
import { FormsModule } from "@angular/forms";
import {
  ALL_FUSION_ALGORITHMS,
  FUSION_ALGORITHM_META,
  SimulationService,
} from "../../services/simulation.service";
import type {
  AlgorithmChartVisibility,
  ChartHistoryPoint,
} from "../../core/models/simulation-state";

const TRUTH_COLOR = "#722ed1";

@Component({
  selector: "app-chart-panel",
  standalone: true,
  imports: [FormsModule, NzCardModule, NzCheckboxModule],
  templateUrl: "./chart-panel.component.html",
  styleUrl: "./chart-panel.component.scss",
})
export class ChartPanelComponent implements AfterViewInit, OnDestroy {
  @ViewChild("distanceCanvas", { static: true })
  distanceCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild("ttlCanvas", { static: true }) ttlCanvas!: ElementRef<HTMLCanvasElement>;

  protected readonly sim = inject(SimulationService);
  protected readonly algorithms = ALL_FUSION_ALGORITHMS;
  protected readonly meta = FUSION_ALGORITHM_META;
  protected visibility: AlgorithmChartVisibility = this.sim.getChartVisibility();

  private sub: Subscription | null = null;

  ngAfterViewInit(): void {
    this.sub = combineLatest([
      this.sim.chartHistory$,
      this.sim.chartVisibility$,
    ]).subscribe(([history, visibility]) => {
      this.visibility = visibility;
      this.drawDistanceChart(history, visibility);
      this.drawTtlChart(history, visibility);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  onVisibilityChange(): void {
    this.sim.setChartVisibility(this.visibility);
  }

  private drawDistanceChart(
    history: ChartHistoryPoint[],
    visibility: AlgorithmChartVisibility,
  ): void {
    const series: { key: string; color: string; label: string; dashed?: boolean; value: (p: ChartHistoryPoint) => number | null }[] = [];
    if (visibility.truth) {
      series.push({
        key: "truth",
        color: TRUTH_COLOR,
        label: "Truth",
        value: (p) => p.truthDistanceM,
      });
    }
    for (const algo of ALL_FUSION_ALGORITHMS) {
      if (!visibility[algo]) {
        continue;
      }
      series.push({
        key: algo,
        color: FUSION_ALGORITHM_META[algo].color,
        label: FUSION_ALGORITHM_META[algo].label,
        value: (p) => p.byAlgorithm[algo]?.distanceM ?? null,
      });
    }
    this.drawSeries(this.distanceCanvas.nativeElement, history, series, "distance");
  }

  private drawTtlChart(
    history: ChartHistoryPoint[],
    visibility: AlgorithmChartVisibility,
  ): void {
    const filtered = history.filter(
      (p) =>
        p.truthTtlSec !== null ||
        ALL_FUSION_ALGORITHMS.some((a) => p.byAlgorithm[a]?.ttlSec != null),
    );
    const series: { key: string; color: string; label: string; dashed?: boolean; value: (p: ChartHistoryPoint) => number | null }[] = [];
    if (visibility.truth) {
      series.push({
        key: "truth",
        color: TRUTH_COLOR,
        label: "Truth TTL",
        value: (p) => p.truthTtlSec,
      });
    }
    for (const algo of ALL_FUSION_ALGORITHMS) {
      if (!visibility[algo]) {
        continue;
      }
      series.push({
        key: algo,
        color: FUSION_ALGORITHM_META[algo].color,
        label: `${FUSION_ALGORITHM_META[algo].label} TTL`,
        value: (p) => p.byAlgorithm[algo]?.ttlSec ?? null,
      });
    }
    this.drawSeries(this.ttlCanvas.nativeElement, filtered, series, "timeToLine");
  }

  private drawSeries(
    canvas: HTMLCanvasElement,
    history: ChartHistoryPoint[],
    series: {
      key: string;
      color: string;
      label: string;
      dashed?: boolean;
      value: (p: ChartHistoryPoint) => number | null;
    }[],
    mode: "distance" | "timeToLine" = "distance",
  ): void {
    const parent = canvas.parentElement;
    if (!parent) {
      return;
    }
    const width = parent.clientWidth;
    const height = 180;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    if (history.length < 2 || series.length === 0) {
      ctx.fillStyle = "#999";
      ctx.font = "13px sans-serif";
      ctx.fillText("Run or step the simulation to populate charts", 16, height / 2);
      return;
    }

    const pad = { l: 48, r: 12, t: 28, b: 28 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;

    const tMin = history[0].simTimeSec;
    const tMax = history[history.length - 1].simTimeSec;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (const p of history) {
      for (const s of series) {
        const v = s.value(p);
        if (v !== null && Number.isFinite(v)) {
          yMin = Math.min(yMin, v);
          yMax = Math.max(yMax, v);
        }
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      return;
    }
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const yPad = (yMax - yMin) * 0.1;
    yMin -= yPad;
    yMax += yPad;

    const xScale = (t: number) => pad.l + ((t - tMin) / Math.max(tMax - tMin, 1e-6)) * plotW;
    const yScale = (v: number) => pad.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    ctx.strokeStyle = "#e8e8e8";
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t + plotH);
    ctx.lineTo(pad.l + plotW, pad.t + plotH);
    ctx.stroke();

    ctx.fillStyle = "#666";
    ctx.font = "11px sans-serif";
    ctx.fillText(mode === "distance" ? "m" : "s", 8, pad.t + 10);
    ctx.fillText("t (s)", pad.l + plotW - 28, height - 6);

    let legendX = pad.l;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, 4, 12, 3);
      ctx.fillStyle = "#333";
      ctx.font = "10px sans-serif";
      ctx.fillText(s.label, legendX + 16, 12);
      legendX += ctx.measureText(s.label).width + 28;
    }

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.dashed ? 1.5 : 2;
      ctx.setLineDash(s.dashed ? [4, 4] : []);
      ctx.beginPath();
      let started = false;
      for (const p of history) {
        const v = s.value(p);
        if (v === null || !Number.isFinite(v)) {
          continue;
        }
        const x = xScale(p.simTimeSec);
        const y = yScale(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
