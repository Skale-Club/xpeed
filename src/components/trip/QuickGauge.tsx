import { cn } from '@/lib/utils';
import { formatValue } from '@/lib/obd/format';

export type GaugeTone = 'primary' | 'success' | 'warn' | 'danger' | 'cold';

const TONE_TEXT: Record<GaugeTone, string> = {
  primary: 'text-primary',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-destructive',
  cold: 'text-[hsl(var(--chart-blue))]',
};

// A half-circle dial (center 50,50) made of upright pills, each pointing at the
// center like the marks on a rev counter, that light up one by one.
const PILLS = 20;
const OUTER = 49;
const INNER = 40.5;
const STROKE = 3.4;

/**
 * Number size in dial units, the same for every reading: big, and still clear
 * of the pills with 4 digits (engine rpm), since it scales with the dial.
 */
const NUMBER_SIZE = 24;
const STEP = 180 / PILLS;

const point = (deg: number, r: number) => {
  const rad = (deg * Math.PI) / 180;
  return `${(50 + r * Math.cos(rad)).toFixed(2)} ${(50 - r * Math.sin(rad)).toFixed(2)}`;
};

const PILL_PATHS = Array.from({ length: PILLS }, (_, i) => {
  const deg = 180 - (i + 0.5) * STEP;
  return `M ${point(deg, INNER)} L ${point(deg, OUTER)}`;
});

/**
 * One big reading on the trip card: the number inside a dial of pills that
 * light up with the value (any value above the minimum lights at least one),
 * colored by how things are (e.g. engine warming up, normal, hot), with a
 * short word for it when there is one.
 */
export function QuickGauge({
  value, unit, label, min = 0, max, tone = 'primary', status,
}: {
  value: number | null;
  unit: string;
  label: string;
  min?: number;
  max: number;
  tone?: GaugeTone;
  status?: string | null;
}) {
  const fraction = value == null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const lit = fraction > 0 ? Math.max(1, Math.round(fraction * PILLS)) : 0;
  const text = formatValue(value, unit);
  return (
    <div className="flex flex-col items-center rounded-xl bg-background/60 px-2 pb-2.5 pt-2" data-testid="quick-gauge">
      <svg viewBox="0 0 100 54" className={cn('w-full max-w-[140px]', TONE_TEXT[tone])} role="img" aria-label={`${text} ${label}`}>
        {PILL_PATHS.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={i < lit ? 'currentColor' : 'hsl(var(--border))'}
            strokeWidth={STROKE}
            strokeLinecap="round"
            className="transition-[stroke] duration-500"
          />
        ))}
        {/* The number is part of the drawing, so it scales with the dial on any screen. */}
        <text
          x="50"
          y="49"
          textAnchor="middle"
          fontSize={NUMBER_SIZE}
          fontWeight={700}
          className="fill-foreground"
          style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}
        >
          {text}
        </text>
      </svg>
      <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 h-4 text-[11px] font-semibold', TONE_TEXT[tone])}>{status ?? ''}</p>
    </div>
  );
}

/** How warm the engine is, for color and a word. */
export function coolantTone(celsius: number | null): GaugeTone {
  if (celsius == null) return 'primary';
  if (celsius < 60) return 'cold';
  if (celsius <= 104) return 'success';
  if (celsius <= 114) return 'warn';
  return 'danger';
}
