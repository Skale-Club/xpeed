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

// Half-circle arc (radius 40) drawn from left to right.
const ARC = 'M 10 50 A 40 40 0 0 1 90 50';
const ARC_LENGTH = Math.PI * 40;

/**
 * One big reading on the trip card: the number over a half-circle dial that
 * fills with the value, colored by how things are (e.g. engine warming up,
 * normal, hot), with a short word for it when there is one.
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
  return (
    <div className="relative flex flex-col items-center rounded-xl bg-background/60 px-2 pb-2.5 pt-2" data-testid="quick-gauge">
      <svg viewBox="0 0 100 56" className={cn('w-full max-w-[120px]', TONE_TEXT[tone])} aria-hidden>
        <path d={ARC} fill="none" stroke="hsl(var(--border))" strokeWidth="7" strokeLinecap="round" />
        <path
          d={ARC}
          fill="none"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${fraction * ARC_LENGTH} ${ARC_LENGTH}`}
          className="transition-[stroke-dasharray] duration-700 ease-out"
        />
      </svg>
      <p className="-mt-8 text-2xl font-bold leading-none tracking-tight tabular-nums sm:text-3xl">{formatValue(value, unit)}</p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{label}</p>
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
