import { Flame, Snowflake } from 'lucide-react';

interface AnomalyBadgeProps {
  /** Z-score of the current value vs the rolling baseline. Negative = below historic avg. */
  zScore: number;
  /** Threshold above which to surface a warning. Default 2. */
  warnAt?: number;
}

/**
 * Shows a "hotter/cooler than usual" badge when the current parameter value
 * is statistically anomalous vs the per-vehicle rolling baseline (z-score).
 * Hidden when |z| < warnAt — most readings are within normal variation.
 */
export default function AnomalyBadge({ zScore, warnAt = 2 }: AnomalyBadgeProps) {
  const abs = Math.abs(zScore);
  if (abs < warnAt) return null;

  const isHigher = zScore > 0;
  const isCritical = abs >= 3;
  const Icon = isHigher ? Flame : Snowflake;
  const color = isCritical
    ? 'text-destructive bg-destructive/10 border-destructive/30'
    : 'text-warn bg-warn/10 border-warn/30';

  return (
    <span
      title={`${abs.toFixed(1)} standard deviations ${isHigher ? 'above' : 'below'} this car's recent baseline`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${color}`}
    >
      <Icon className="w-3 h-3" />
      {isHigher ? 'Hotter than usual' : 'Cooler than usual'}
    </span>
  );
}
