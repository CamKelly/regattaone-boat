/**
 * Rolling time-series for four numeric channels from MSP430 UART lines (TOF / metrics).
 */

const MAX_POINTS = 400;
/** Room for two-line header + axis captions. */
const TOP_TITLE = 30;
const BAND_GAP = 2;
/** Stroke width for traces (CSS pixels; thin line). */
const TRACE_LINE_WIDTH = 1;
/** Engineering-style arbitrary units until firmware sends explicit labels. */
const VALUE_UNIT = "a.u.";

const COLORS = ["#fb923c", "#38bdf8", "#a78bfa", "#4ade80"] as const;
const SHORTS = ["v0", "v1", "v2", "v3"] as const;

function shift4(arrs: number[][]): void {
  for (const a of arrs) {
    while (a.length > MAX_POINTS) {
      a.shift();
    }
  }
}

function shiftTimes(arr: number[]): void {
  while (arr.length > MAX_POINTS) {
    arr.shift();
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

/**
 * Parse a line into four numbers: comma/semicolon/tab-separated, or any four numeric tokens.
 */
export function parseFourNumericFields(line: string): [number, number, number, number] | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) {
    return null;
  }

  const splitNums: number[] = [];
  for (const part of s.split(/[,;\t]+/)) {
    const t = part.trim();
    if (!t) {
      continue;
    }
    const v = Number.parseFloat(t);
    if (Number.isFinite(v)) {
      splitNums.push(v);
    }
    if (splitNums.length >= 4) {
      return [splitNums[0]!, splitNums[1]!, splitNums[2]!, splitNums[3]!];
    }
  }

  const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const scanned: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null && scanned.length < 4) {
    const v = Number.parseFloat(m[0]);
    if (Number.isFinite(v)) {
      scanned.push(v);
    }
  }
  if (scanned.length >= 4) {
    return [scanned[0]!, scanned[1]!, scanned[2]!, scanned[3]!];
  }
  return null;
}

export class Msp430FourChannelPlot {
  private readonly ch: [number[], number[], number[], number[]] = [[], [], [], []];
  /** Monotonic receive time (ms) per row; parallel to each `ch[i]`. */
  private sampleWallMs: number[] = [];
  private dirty = true;

  pushSample(vals: [number, number, number, number]): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    for (let i = 0; i < 4; i++) {
      this.ch[i]!.push(vals[i]!);
    }
    this.sampleWallMs.push(now);
    shift4(this.ch);
    shiftTimes(this.sampleWallMs);
    this.dirty = true;
  }

  clear(): void {
    for (let i = 0; i < 4; i++) {
      this.ch[i]!.length = 0;
    }
    this.sampleWallMs.length = 0;
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

  paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0c1018";
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "bold 11px system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("MSP430 UART · four channels", 6, 12);

    ctx.fillStyle = "#64748b";
    ctx.font = "9px system-ui,sans-serif";
    ctx.fillText(
      `Horizontal: wall time within window (older ← → newer) · Vertical: numeric value [${VALUE_UNIT}] · thin traces`,
      6,
      24,
    );

    const y0 = TOP_TITLE;
    const usableH = h - y0 - 6;
    const bandCount = 4;
    const bandH = (usableH - BAND_GAP * (bandCount - 1)) / bandCount;

    let y = y0;
    for (let i = 0; i < 4; i++) {
      this.paintBand(ctx, 0, y, w, bandH, i, SHORTS[i]!, COLORS[i]!, this.ch[i]!, this.sampleWallMs);
      y += bandH + BAND_GAP;
    }
  }

  private paintBand(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    bandH: number,
    channelIndex: number,
    short: string,
    color: string,
    vals: number[],
    times: number[],
  ): void {
    const padL = 6;
    const padR = 52;
    const padT = 13;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = bandH - padT - padB;
    const px0 = x + padL;
    const py0 = y + padT;

    const title = `Channel ${channelIndex} · ${short} [${VALUE_UNIT}]`;

    ctx.fillStyle = "rgba(30, 41, 59, 0.55)";
    ctx.fillRect(x, y, w, bandH);

    ctx.strokeStyle = "rgba(71, 85, 105, 0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, bandH - 1);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "9px system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(title, px0, y + 11);

    const mm = finiteMinMax(vals);
    const n = vals.length;
    const timesAligned = n === times.length ? times : [];

    if (!mm) {
      ctx.fillStyle = "#475569";
      ctx.textAlign = "center";
      ctx.fillText(vals.length === 0 ? "…" : "no numeric data", x + w / 2, py0 + plotH / 2);
      ctx.fillStyle = color;
      ctx.fillRect(px0, y + 2, 6, 2);
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "left";
      ctx.fillText(short, px0 + 10, y + 6);
      return;
    }
    const vmin = mm.min;
    const vmax = mm.max;

    const yScale = (v: number) => {
      if (!Number.isFinite(v)) {
        return NaN;
      }
      const t = (v - vmin) / (vmax - vmin);
      return py0 + plotH - t * plotH;
    };
    const xScale = (i: number) => {
      if (n < 2) {
        return px0;
      }
      return px0 + (i / (n - 1)) * plotW;
    };

    ctx.strokeStyle = "rgba(51, 65, 105, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px0, py0 + plotH);
    ctx.lineTo(px0 + plotW, py0 + plotH);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = TRACE_LINE_WIDTH;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]!;
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

    ctx.fillStyle = "#94a3b8";
    ctx.font = "8px ui-monospace, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${fmtAxisNum(vmax)} ${VALUE_UNIT}`, x + w - 4, py0 + 8);
    ctx.fillText(`${fmtAxisNum(vmin)} ${VALUE_UNIT}`, x + w - 4, py0 + plotH);

    ctx.fillStyle = color;
    ctx.fillRect(px0, y + 2, 6, 2);
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "left";
    ctx.font = "8px system-ui,sans-serif";
    ctx.fillText(short, px0 + 10, y + 6);

    if (timesAligned.length >= 2 && n >= 2) {
      const t0 = timesAligned[0]!;
      const t1 = timesAligned[timesAligned.length - 1]!;
      const spanS = (t1 - t0) / 1000;
      ctx.fillStyle = "#64748b";
      ctx.font = "8px ui-monospace, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`t +0.00 s`, px0, py0 + plotH + 11);
      ctx.textAlign = "center";
      ctx.fillText("wall time →", px0 + plotW / 2, py0 + plotH + 11);
      ctx.textAlign = "right";
      ctx.fillText(`Δ ${spanS.toFixed(2)} s · n=${n}`, px0 + plotW, py0 + plotH + 11);
    } else if (n >= 1) {
      ctx.fillStyle = "#64748b";
      ctx.font = "8px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("sample index → (need ≥2 pts for time span)", px0 + plotW / 2, py0 + plotH + 11);
    }
  }
}

function fmtAxisNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000 || (a > 0 && a < 0.01)) {
    return v.toExponential(2);
  }
  return v.toPrecision(4);
}
