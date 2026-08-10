import * as echarts from "echarts";

export interface RelativePoint {
  name: string;
  x: number;
  y: number;
}

let chart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function tooltipText(point: RelativePoint): string {
  return `<strong>${point.name}</strong><br/>x ${point.x.toFixed(2)} m<br/>y ${point.y.toFixed(2)} m`;
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
      animationDurationUpdate: 250,
      grid: { left: 58, right: 24, top: 34, bottom: 52 },
      tooltip: {
        trigger: "item",
        formatter: (params: { data?: RelativePoint }) => params.data ? tooltipText(params.data) : "",
      },
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
          name: "Start line",
          type: "line",
          symbol: "none",
          silent: true,
          lineStyle: { color: "#64748b", width: 3 },
          data: anchors.length >= 2 ? [[anchors[0].x, anchors[0].y], [anchors[1].x, anchors[1].y]] : [],
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
          label: { show: true, formatter: "{b}", position: "top", fontWeight: 600 },
          data: anchors,
        },
        {
          name: "Boat",
          type: "scatter",
          symbol: "diamond",
          symbolSize: 24,
          itemStyle: { color: "#1677ff", borderColor: "#fff", borderWidth: 2 },
          label: { show: true, formatter: "Boat", position: "top", fontWeight: 600 },
          data: boat ? [boat] : [],
        },
      ],
    },
    true,
  );
}

export function resizeRelativePositionChart(): void {
  chart?.resize();
}

