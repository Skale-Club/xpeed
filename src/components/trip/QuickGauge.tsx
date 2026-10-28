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

const TONE_BG: Record<GaugeTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-destructive',
  cold: 'bg-[hsl(var(--chart-blue))]',
};

const PILLS = 5;

/**
 * One big reading on the trip card: the number over a row of pills that light
 * up with the value (any value above the minimum lights at least one), colored
 * by how things are (e.g. engine warming up, normal, hot), with a short word
 * for it when there is one.
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
  return (
    <div className="flex flex-col items-center rounded-xl bg-background/60 px-2.5 pb-2.5 pt-3" data-testid="quick-gauge">
      <p className="text-2xl font-bold leading-none tracking-tight tabular-nums sm:text-3xl">{formatValue(value, unit)}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
      <div className="mt-2.5 flex w-full gap-[3px] px-0.5" aria-hidden>
        {Array.from({ length: PILLS }, (_, i) => (
          <span
            key={i}
            className={cn('h-1.5 min-w-0 flex-1 rounded-full transition-colors duration-500', i < lit ? TONE_BG[tone] : 'bg-border')}
          />
        ))}
      </div>
      <p className={cn('mt-1.5 h-4 text-[11px] font-semibold', TONE_TEXT[tone])}>{status ?? ''}</p>
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
