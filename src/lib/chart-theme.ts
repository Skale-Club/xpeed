// Dashboards 2027 (proposed 2026-11-20, owner study "Xpeed Painéis 2027"; pending approval on /admin/design).
// The numbers and colours of the shared chart look; the components that use them are in src/components/ui/chart-kit.tsx.
// Colour comes in breaks: each number or block picks an accent from the chart palette; yellow stays the brand's mark
// (where you are, a record), never the colour of everything (owner, 2026-11-20).
import { tokenColor } from "@/lib/design-tokens";

/** The accents a tile, a panel or a series can take, read from the chart tokens (--chart-1 … --chart-9). */
export const ACCENT_TOKEN = {
  yellow: "chart-1",
  blue: "chart-2",
  purple: "chart-3",
  green: "chart-4",
  amber: "chart-5",
  pink: "chart-6",
  red: "chart-7",
  indigo: "chart-8",
  sky: "chart-9",
} as const;

export type Accent = keyof typeof ACCENT_TOKEN;

/** The accent as a concrete colour string (Recharts and inline SVG need one), with optional alpha. */
export const accentColor = (accent: Accent, alpha?: number): string => tokenColor(ACCENT_TOKEN[accent], alpha);

/** Axis ticks: small, muted, no tick marks, no axis line. Spread into `<XAxis>` / `<YAxis>`. */
export const CHART_AXIS = {
  tick: { fontSize: 11, fill: "hsl(var(--muted-foreground))" },
  tickLine: false,
  axisLine: false,
} as const;

/** Only horizontal lines, dashed and faint. Spread into `<CartesianGrid>`. */
export const CHART_GRID = {
  vertical: false,
  stroke: "hsl(var(--foreground) / 0.06)",
  strokeDasharray: "3 4",
} as const;

/** The tooltip box: the raised surface, a hairline border, 12 px text. Spread into `<Tooltip>`. */
export const CHART_TOOLTIP = {
  contentStyle: {
    background: "hsl(var(--surface-overlay) / 0.96)",
    border: "1px solid hsl(var(--border-strong))",
    borderRadius: 10,
    fontSize: 12,
    boxShadow: "var(--shadow-overlay)",
  },
  labelStyle: { color: "hsl(var(--muted-foreground))", marginBottom: 2 },
  cursor: { stroke: "hsl(var(--foreground) / 0.15)", strokeWidth: 1, fill: "hsl(var(--foreground) / 0.04)" },
} as const;

/** A line series: 2 px, smooth, no dot on each value, a ringed dot on hover. Spread into `<Line>` / `<Area>`. */
export const CHART_LINE = {
  type: "monotone",
  strokeWidth: 2,
  dot: false,
  activeDot: { r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" },
  isAnimationActive: false,
} as const;

/** A bar series: rounded top, never wider than 46 px. Spread into `<Bar>`. */
export const CHART_BAR = {
  radius: [4, 4, 0, 0] as [number, number, number, number],
  maxBarSize: 46,
  isAnimationActive: false,
} as const;

/** The colour of an empty bar (a day with nothing), so a quiet day still shows its place. */
export const GHOST_BAR = "hsl(var(--foreground) / 0.06)";

/** The area under a line fades from this opacity at the top to nothing at the bottom. */
export const AREA_TOP_OPACITY = 0.22;

/** The path of a sparkline in a `width` x `height` box, with the last point; flat or single values draw a line in the middle. */
export function sparkPoints(values: readonly number[], width: number, height: number, pad = 4): { line: string; area: string; last: { x: number; y: number } | null } {
  if (values.length === 0) return { line: "", area: "", last: null };
  const series = values.length === 1 ? [values[0], values[0]] : values;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const range = max - min || 1;
  const points = series.map((value, i) => ({
    x: (i / (series.length - 1)) * width,
    y: max === min ? height / 2 : pad + (height - 2 * pad) * (1 - (value - min) / range),
  }));
  const line = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, last: points[points.length - 1] };
}
