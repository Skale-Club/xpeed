// Dashboards 2027 (proposed 2026-11-20, owner study "Xpeed Painéis 2027"; pending approval on /admin/design).
// The components of the one chart look of the dashboards (the constants are in src/lib/chart-theme.ts), so Real, Virtual and RC draw the same way:
// thin lines with no dot on each value, a fading area, a near-invisible horizontal grid, legends as chips above the chart,
// bars with a rounded top. Colour comes in breaks: each number or block picks an accent from the chart palette; yellow stays
// the brand's mark (where you are, a record), never the colour of everything (owner, 2026-11-20).
import { useId, useMemo } from "react";

import { AREA_TOP_OPACITY, sparkPoints } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

/** The `<linearGradient>` an `<Area fill="url(#id)">` uses; put it inside the chart's `<defs>`. */
export function AreaGradient({ id, color, opacity = AREA_TOP_OPACITY }: { id: string; color: string; opacity?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={opacity} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  /** A dashed series (a reference, a target) shows a dashed swatch. */
  dashed?: boolean;
}

/** The legend of a chart, as small chips; it goes in the panel's header (`action`), not under the chart. */
export function ChartLegend({ items, className, testId }: { items: readonly LegendItem[]; className?: string; testId?: string }) {
  return (
    <ul className={cn("flex flex-wrap justify-end gap-1.5", className)} data-testid={testId}>
      {items.map((item) => (
        <li key={item.label} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-secondary-foreground">
          <span
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={item.dashed ? { background: `repeating-linear-gradient(90deg, ${item.color} 0 3px, transparent 3px 5px)` } : { background: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * A small line of values with a fading area under it and its last point marked; decorative (the tile around it says the numbers).
 * It stretches to its box: give it a height through `className` (default 28 px).
 */
export function AreaSparkline({ values, color, className, strong = false, testId = "area-sparkline" }: { values: readonly number[]; color: string; className?: string; strong?: boolean; testId?: string }) {
  const gradient = `spark-${useId().replace(/:/g, "")}`;
  const W = 300;
  const H = 100;
  const path = useMemo(() => sparkPoints(values, W, H, 8), [values]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("block h-7 w-full", className)} aria-hidden="true" focusable="false" data-testid={testId} data-points={values.length}>
      <defs><AreaGradient id={gradient} color={color} opacity={strong ? 0.32 : AREA_TOP_OPACITY} /></defs>
      {path.line && <path d={path.area} fill={`url(#${gradient})`} />}
      {path.line && <path d={path.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
