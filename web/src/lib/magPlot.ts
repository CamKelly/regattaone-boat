/**
 * Rolling time-series painted to a 2D canvas (screen overlay in main.ts).
 * Bands: mag X/Y/Z, |gyro|, |accel|, temperature, pressure, Δalt vs first P, heading vs +Z, packet dt.
 */

const MAX_POINTS = 400;
const TOP_TITLE = 14;
const BAND_GAP = 2;

export type TelemetrySample = {
  mx: number;
  my: number;
  mz: number;
  gyroMag: number;
  accMag: number;
  tempC: number;
  pressHpa: number;
  headingDeg: number;
  dtMs: number;
};

function shiftArrays<T>(arrs: T[][]): void {
  for (const a of arrs) {
    while (a.length > MAX_POINTS) {
      a.shift();
    }
  }
}

function finiteMinMax(vals: number[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (Number.isFinite(v)) {
      if (v < min) {
        min = v;
      }
      if (v > max) {
        max = v;
      }
    }
  }
  if (min === Infinity) {
    return null;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  return { min: min - span * 0.06, max: max + span * 0.06 };
}

/** Unwrap heading (°) for continuous line across 0/360. */
function unwrapHeadingSeries(deg: number[]): number[] {
  const out = deg.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    let cur = out[i]!;
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) {
      continue;
    }
    while (cur - prev > 180) {
      cur -= 360;
    }
    while (cur - prev < -180) {
      cur += 360;
    }
    out[i] = cur;
  }
  return out;
}

export class MagTimePlot {
  private mx: number[] = [];
  private my: number[] = [];
  private mz: number[] = [];
  private gyroMag: number[] = [];
  private accMag: number[] = [];
  private tempC: number[] = [];
  private pressHpa: number[] = [];
  private headingDeg: number[] = [];
  private dtMs: number[] = [];
  /** First finite pressure in this enabled session (hPa); used for approximate Δalt. */
  private pressRefHpa: number | null = null;
  private relAltM: number[] = [];
  private dirty = false;
  enabled = false;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.mx = [];
      this.my = [];
      this.mz = [];
      this.gyroMag = [];
      this.accMag = [];
      this.tempC = [];
      this.pressHpa = [];
      this.headingDeg = [];
      this.dtMs = [];
      this.relAltM = [];
      this.pressRefHpa = null;
    }
    this.dirty = true;
  }

  pushSample(s: TelemetrySample): void {
    if (!this.enabled) {
      return;
    }
    if (Number.isFinite(s.pressHpa) && this.pressRefHpa === null) {
      this.pressRefHpa = s.pressHpa;
    }
    const altM =
      this.pressRefHpa !== null && Number.isFinite(s.pressHpa) && this.pressRefHpa > 0
        ? 44330 * (1 - Math.pow(s.pressHpa / this.pressRefHpa, 0.1903))
        : NaN;
    this.mx.push(s.mx);
    this.my.push(s.my);
    this.mz.push(s.mz);
    this.gyroMag.push(s.gyroMag);
    this.accMag.push(s.accMag);
    this.tempC.push(s.tempC);
    this.pressHpa.push(s.pressHpa);
    this.headingDeg.push(s.headingDeg);
    this.dtMs.push(s.dtMs);
    this.relAltM.push(altM);
    shiftArrays([
      this.mx,
      this.my,
      this.mz,
      this.gyroMag,
      this.accMag,
      this.tempC,
      this.pressHpa,
      this.headingDeg,
      this.dtMs,
      this.relAltM,
    ]);
    this.dirty = true;
  }

  paintIfDirty(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
    if (!this.dirty) {
      return false;
    }
    this.dirty = false;
    this.paint(ctx, w, h);
    return true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  private paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0c1018";
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 11px system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Telemetry · time →", 6, 11);

    const y0 = TOP_TITLE;
    const usableH = h - y0 - 4;
    const bandCount = 8;
    const bandH = (usableH - BAND_GAP * (bandCount - 1)) / bandCount;

    let y = y0;
    const band = (
      title: string,
      traces: { vals: number[]; color: string; short: string }[],
      fixed?: { min: number; max: number },
    ): void => {
      this.paintBand(ctx, 0, y, w, bandH, title, traces, fixed);
      y += bandH + BAND_GAP;
    };

    band(
      "Mag (raw counts)",
      [
        { vals: this.mx, color: "#fb923c", short: "X" },
        { vals: this.my, color: "#38bdf8", short: "Y" },
        { vals: this.mz, color: "#a78bfa", short: "Z" },
      ],
    );
    band("|ω| rad/s", [{ vals: this.gyroMag, color: "#f472b6", short: "‖g‖" }]);
    band("|a| g", [{ vals: this.accMag, color: "#4ade80", short: "‖a‖" }]);
    band("Temp °C", [{ vals: this.tempC, color: "#fcd34d", short: "T" }]);
    band("Press hPa", [{ vals: this.pressHpa, color: "#5eead4", short: "P" }]);
    band("Δ alt m (vs 1st P)", [{ vals: this.relAltM, color: "#c4b5fd", short: "Δh" }]);
    const hUnwrap = unwrapHeadingSeries(this.headingDeg);
    band(
      "Heading ° (vs +Z)",
      [{ vals: hUnwrap, color: "#86efac", short: "H" }],
    );
    band("Packet dt ms", [{ vals: this.dtMs, color: "#94a3b8", short: "dt" }]);
  }

  private paintBand(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    bandH: number,
    title: string,
    traces: { vals: number[]; color: string; short: string }[],
    fixed?: { min: number; max: number },
  ): void {
    const padL = 4;
    const padR = 36;
    const padT = 12;
    const padB = 3;
    const plotW = w - padL - padR;
    const plotH = bandH - padT - padB;
    const px0 = x + padL;
    const py0 = y + padT;

    ctx.fillStyle = "rgba(30, 41, 59, 0.55)";
    ctx.fillRect(x, y, w, bandH);

    ctx.strokeStyle = "rgba(71, 85, 105, 0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, bandH - 1);

    ctx.fillStyle = "#64748b";
    ctx.font = "9px system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(title, px0, y + 10);

    let vmin: number;
    let vmax: number;
    if (fixed) {
      vmin = fixed.min;
      vmax = fixed.max;
    } else {
      const all: number[] = [];
      for (const t of traces) {
        for (const v of t.vals) {
          if (Number.isFinite(v)) {
            all.push(v);
          }
        }
      }
      const mm = finiteMinMax(all);
      if (!mm) {
        ctx.fillStyle = "#475569";
        ctx.textAlign = "center";
        ctx.fillText(this.enabled ? "…" : "Off", x + w / 2, py0 + plotH / 2);
        return;
      }
      vmin = mm.min;
      vmax = mm.max;
    }

    const yScale = (v: number) => {
      if (!Number.isFinite(v)) {
        return NaN;
      }
      const t = (v - vmin) / (vmax - vmin);
      return py0 + plotH - t * plotH;
    };
    const n = traces[0]?.vals.length ?? 0;
    const xScale = (i: number) => {
      if (n < 2) {
        return px0;
      }
      return px0 + (i / (n - 1)) * plotW;
    };

    ctx.strokeStyle = "rgba(51, 65, 85, 0.5)";
    ctx.beginPath();
    ctx.moveTo(px0, py0 + plotH);
    ctx.lineTo(px0 + plotW, py0 + plotH);
    ctx.stroke();

    for (const t of traces) {
      ctx.beginPath();
      ctx.strokeStyle = t.color;
      ctx.lineWidth = Math.max(1, bandH / 50);
      let started = false;
      for (let i = 0; i < t.vals.length; i++) {
        const v = t.vals[i]!;
        const yy = yScale(v);
        const xx = xScale(i);
        if (!Number.isFinite(yy)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(xx, yy);
          started = true;
        } else {
          ctx.lineTo(xx, yy);
        }
      }
      ctx.stroke();
    }

    ctx.fillStyle = "#64748b";
    ctx.font = "8px system-ui,sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(vmax.toFixed(fixed && Math.abs(vmax) < 20 ? 1 : 0), x + w - 4, py0 + 8);
    ctx.fillText(vmin.toFixed(fixed && Math.abs(vmin) < 20 ? 1 : 0), x + w - 4, py0 + plotH);

    let lx = px0;
    for (const t of traces) {
      ctx.fillStyle = t.color;
      ctx.fillRect(lx, y + 2, 8, 3);
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "left";
      ctx.fillText(t.short, lx + 10, y + 6);
      lx += 28;
    }
  }
}
