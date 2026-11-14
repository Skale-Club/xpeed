import { useTranslation } from 'react-i18next';
import { ArrowDown, Minus, Sparkles } from 'lucide-react';
import { type PbTrend } from '@/lib/sim/garage';

/**
 * Where a personal best stands against 30 days ago: an arrow down (a faster lap) with the seconds gained, a dash when it has not moved, a spark when
 * the first valid lap came within the 30 days. Words for the screen reader, so the arrow is never the only thing said. Nothing for no valid lap.
 */
export function PbTrendChip({ trend }: { trend: PbTrend }) {
  const { t } = useTranslation();
  if (trend.kind === 'none') return null;
  if (trend.kind === 'faster' && trend.gainMs !== null) {
    const seconds = (trend.gainMs / 1000).toFixed(3);
    const text = t('garageDash.trendFaster', '{{seconds}} s faster than 30 days ago', { seconds });
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-success" title={text} data-testid="pb-trend" data-trend="faster">
        <ArrowDown className="h-3 w-3" aria-hidden="true" />
        <span aria-hidden="true">-{seconds} s</span>
        <span className="sr-only">{text}</span>
      </span>
    );
  }
  const text = trend.kind === 'steady' ? t('garageDash.trendSteady', 'Same best as 30 days ago') : t('garageDash.trendFirst', 'First valid lap in the last 30 days');
  const Icon = trend.kind === 'steady' ? Minus : Sparkles;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={text} data-testid="pb-trend" data-trend={trend.kind}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </span>
  );
}
