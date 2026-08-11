import * as echarts from "echarts";

export interface RelativePoint {
  name: string;
  x: number;
  y: number;
  stale?: boolean;
}

let chart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function tooltipText(point: RelativePoint): string {
  const labels: Record<string, string> = { P: "Port", S: "Starboard", B: "Boat" };
  return `<strong>${point.name} · ${labels[point.name] ?? point.name}</strong><br/>x ${point.x.toFixed(2)} m<br/>y ${point.y.toFixed(2)} m`;
}

function scatterDatum(point: RelativePoint) {
  return {
    name: point.name,
    value: [point.x, point.y],
    point,
    itemStyle: point.stale ? { color: "#94a3b8", borderColor: "#fff", borderWidth: 2 } : undefined,
  };
}

function anchorDistanceLabels(anchors: RelativePoint[]) {
  const pairs: Array<[string, string]> = [["P", "S"]];
  return pairs.flatMap(([aName, bName]) => {
    const a = anchors.find((p) => p.name === aName);
    const b = anchors.find((p) => p.name === bName);
    if (!a || !b) {
      return [];
    }
    const metres = Math.hypot(b.x - a.x, b.y - a.y);
    return [{
      name: `${aName}–${bName}`,
      value: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      from: [a.x, a.y],
      to: [b.x, b.y],
      labelText: `${aName}–${bName}  ${(metres * 100).toFixed(0)} cm · ${(metres * 39.37007874).toFixed(1)} in`,
    }];
  });
}

export function renderRelativePositionChart(
  anchors: RelativePoint[],
  boat: RelativePoint | null,
  trail: RelativePoint[],
): void {
  const el = document.querySelector<HTMLElement>("#relative-position-chart");
  if (!el) {
    return;
  }
  if (!chart) {
    chart = echarts.init(el);
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(el);
  }

  const all = [...anchors, ...trail, ...(boat ? [boat] : [])];
  const dimensions = anchorDistanceLabels(anchors);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const rawMin = Math.min(-1, ...xs, ...ys);
  const rawMax = Math.max(3, ...xs, ...ys);
  const span = Math.max(4, rawMax - rawMin);
  const pad = Math.max(0.75, span * 0.15);
  const min = Math.floor((rawMin - pad) * 2) / 2;
  const max = Math.ceil((rawMax + pad) * 2) / 2;

  chart.setOption(
    {
      animation: false,
      grid: { left: 58, right: 24, top: 34, bottom: 52 },
      tooltip: {
        trigger: "item",
        formatter: (params: { data?: { point?: RelativePoint } }) =>
          params.data?.point ? tooltipText(params.data.point) : "",
      },
      toolbox: {
        right: 18,
        feature: {
          dataZoom: { yAxisIndex: "all", title: { zoom: "Zoom", back: "Undo zoom" } },
          restore: { title: "Reset view" },
        },
      },
      dataZoom: [
        {
          type: "inside",
          xAxisIndex: 0,
          filterMode: "none",
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
        {
          type: "inside",
          yAxisIndex: 0,
          filterMode: "none",
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
      ],
      xAxis: {
        type: "value",
        name: "Port → Starboard (m)",
        nameLocation: "middle",
        nameGap: 34,
        min,
        max,
        splitLine: { lineStyle: { color: "#edf0f2" } },
        axisLine: { onZero: true },
      },
      yAxis: {
        type: "value",
        name: "Perpendicular (m)",
        nameLocation: "middle",
        nameGap: 42,
        min,
        max,
        splitLine: { lineStyle: { color: "#edf0f2" } },
        axisLine: { onZero: true },
      },
      series: [
        {
          name: "Anchor distances",
          type: "scatter",
          symbolSize: 1,
          silent: true,
          itemStyle: { opacity: 0 },
          label: {
            show: true,
            formatter: (params: { data?: { labelText?: string } }) => params.data?.labelText ?? "",
            position: "top",
            distance: 8,
            padding: [4, 7],
            borderRadius: 4,
            backgroundColor: "rgba(255,255,255,.9)",
            borderColor: "#d9d9d9",
            borderWidth: 1,
            color: "#334155",
            fontSize: 11,
          },
          data: dimensions,
          markLine: {
            silent: true,
            symbol: ["none", "none"],
            lineStyle: { color: "#94a3b8", width: 1, type: "dashed" },
            label: { show: false },
            data: dimensions.map((d) => [{ coord: d.from }, { coord: d.to }]),
          },
        },
        {
          name: "Trail",
          type: "line",
          showSymbol: false,
          silent: true,
          lineStyle: { color: "rgba(22,119,255,.35)", width: 1.5 },
          data: trail.map((p) => [p.x, p.y]),
        },
        {
          name: "Marks",
          type: "scatter",
          symbolSize: 20,
          itemStyle: { color: "#d4380d", borderColor: "#fff", borderWidth: 2 },
          label: { show: true, formatter: "{b}", position: "top", fontSize: 14, fontWeight: 700 },
          data: anchors.map(scatterDatum),
        },
        {
          name: "Boat",
          type: "scatter",
          symbol: "diamond",
          symbolSize: 24,
          itemStyle: { color: "#1677ff", borderColor: "#fff", borderWidth: 2 },
          label: { show: true, formatter: "B", position: "top", fontSize: 14, fontWeight: 700 },
          data: boat ? [scatterDatum(boat)] : [],
        },
      ],
    },
    { notMerge: false, replaceMerge: ["series"] },
  );
}

export function resizeRelativePositionChart(): void {
  chart?.resize();
}
