import { PillDial, type GaugeTone } from '@/components/trip/QuickGauge';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatValue } from '@/lib/obd/format';

// Live-panel widgets. Hand-drawn SVG instead of a chart library: they redraw
// several times a second and only need a few primitives.

const ACCENT = CHART_PALETTE.yellow;

interface Readout {
  label: string;
  unit: string;
  value: number | null | undefined;
}

export function GaugeWidget({ label, unit, value, min, max, tone }: Readout & { min: number; max: number; tone?: GaugeTone }) {
  return (
    <div className="flex flex-col items-center" role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value ?? undefined}>
      <PillDial value={value ?? null} unit={unit} label={label} min={min} max={max} tone={tone} className="max-w-[200px]" />
      <div className="mt-1 flex w-full max-w-[200px] justify-between px-1 text-[10px] tabular-nums text-muted-foreground">
        <span>{min}</span>
        <span>{unit}</span>
        <span>{max}</span>
      </div>
      <p className="mt-0.5 max-w-full truncate text-center text-xs text-muted-foreground" title={label}>{label}</p>
    </div>
  );
}

export function ValueWidget({ label, unit, value }: Readout) {
  return (
    <div className="flex flex-col justify-center h-full">
      <p className="text-xs text-muted-foreground truncate" title={label}>{label}</p>
      <p className="text-3xl font-bold text-foreground tabular-nums leading-tight">
        {formatValue(value, unit)}
        <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>
      </p>
    </div>
  );
}

export interface ChartPoint {
  at: number;
  v: number | null;
}

const CHART_W = 300;
const CHART_H = 100;

export function ChartWidget({ label, unit, points, now, windowMs }: Omit<Readout, 'value'> & { points: ChartPoint[]; now: number; windowMs: number }) {
  const from = now - windowMs;
  const visible = points.filter((p) => p.at >= from);
  const nums = visible.flatMap((p) => (p.v == null ? [] : [p.v]));
  const current = visible.length ? visible[visible.length - 1].v : null;
  let lo = nums.length ? Math.min(...nums) : 0;
  let hi = nums.length ? Math.max(...nums) : 1;
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;

  // Break the line where values are missing.
  const segments: string[] = [];
  let segment: string[] = [];
  for (const p of visible) {
    if (p.v == null) {
      if (segment.length) segments.push(segment.join(' '));
      segment = [];
      continue;
    }
    const x = ((p.at - from) / windowMs) * CHART_W;
    const y = CHART_H - ((p.v - lo) / (hi - lo)) * CHART_H;
    segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (segment.length) segments.push(segment.join(' '));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs text-muted-foreground truncate" title={label}>{label}</p>
        <p className="text-lg font-bold tabular-nums">
          {formatValue(current, unit)}<span className="text-xs font-normal text-muted-foreground ml-1">{unit}</span>
        </p>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="w-full h-28 rounded bg-muted/30" role="img" aria-label={`${label} chart`}>
          {segments.map((pts, i) => (
            <polyline key={i} points={pts} fill="none" stroke={ACCENT} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          ))}
        </svg>
        {nums.length > 0 && (
          <>
            <span className="absolute top-0.5 right-1 text-[10px] text-muted-foreground font-mono">{formatValue(Math.max(...nums), unit)}</span>
            <span className="absolute bottom-0.5 right-1 text-[10px] text-muted-foreground font-mono">{formatValue(Math.min(...nums), unit)}</span>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground text-right">{Math.round(windowMs / 1000)} s</p>
    </div>
  );
}

export function BlocksWidget({ blocks, label }: { blocks: { index: number; value: number | null }[]; label: string }) {
  const nums = blocks.flatMap((b) => (b.value == null ? [] : [b.value]));
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 0;
  // Zoom the scale around the pack so small imbalances are visible.
  const lo = min - 0.3;
  const hi = max + 0.1;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        {nums.length > 0 && (
          <p className="text-xs font-mono">
            <span className="text-muted-foreground">Δ </span>
            <span className="font-bold">{(max - min).toFixed(3)} V</span>
          </p>
        )}
      </div>
      <div className="flex items-end gap-1 h-36">
        {blocks.map((b) => {
          const frac = b.value == null ? 0 : (b.value - lo) / (hi - lo);
          const isMin = b.value != null && nums.length > 1 && b.value === min;
          const isMax = b.value != null && nums.length > 1 && b.value === max;
          const color = isMin ? CHART_PALETTE.amber : isMax ? CHART_PALETTE.blue : ACCENT;
          return (
            <div key={b.index} className="flex-1 flex flex-col items-center justify-end h-full min-w-0" data-testid={`hv-block-${b.index}`}>
              <span className="text-[9px] font-mono text-muted-foreground mb-0.5 [writing-mode:vertical-rl] sm:[writing-mode:horizontal-tb]">
                {b.value == null ? '—' : b.value.toFixed(2)}
              </span>
              <div className="w-full rounded-t" style={{ height: `${Math.max(2, frac * 100)}%`, background: color, opacity: b.value == null ? 0.2 : 1 }} />
              <span className="text-[9px] font-mono text-muted-foreground mt-0.5">{b.index}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
