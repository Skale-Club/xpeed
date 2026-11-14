import { useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { STATS_RANGES, type StatsRange } from '@/lib/sim/v1-client';

/** The period of the dashboard: five buttons that are one choice (a radio group: arrows move between them, Tab goes past). */
export function RangeSelect({ value, onChange, busy }: { value: StatsRange; onChange: (range: StatsRange) => void; busy?: boolean }) {
  const { t } = useTranslation();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const labels: Record<StatsRange, string> = {
    '7d': t('modes.overview.dash.range7d', '7 days'),
    '30d': t('modes.overview.dash.range30d', '30 days'),
    '90d': t('modes.overview.dash.range90d', '90 days'),
    '1y': t('modes.overview.dash.range1y', '12 months'),
    all: t('modes.overview.dash.rangeAll', 'All'),
  };
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + STATS_RANGES.length) % STATS_RANGES.length;
    onChange(STATS_RANGES[next]);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={t('modes.overview.dash.rangeLabel', 'Period')}
      aria-busy={busy || undefined}
      className="flex w-full rounded-lg border border-border bg-muted/40 p-0.5 sm:inline-flex sm:w-auto"
      data-testid="range-select"
    >
      {STATS_RANGES.map((range, index) => {
        const selected = range === value;
        return (
          <button
            key={range}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(range)}
            onKeyDown={(event) => move(event, index)}
            data-testid={`range-${range}`}
            className={`flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none ${
              selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {labels[range]}
          </button>
        );
      })}
    </div>
  );
}

/** With no computer paired: a compact invitation to get Xpeed Companion and connect it (the same two links as everywhere else). */
export function CompanionBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2" data-testid="overview-companion">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {t('modes.overview.connectBody', 'Connect Xpeed Companion on the computer you race on, and your laps arrive here by themselves.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to="/companion" data-testid="overview-download"><Download className="mr-2 h-4 w-4" />{t('modes.states.install', 'Get Xpeed Companion')}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/virtual/companion" data-testid="overview-connect">{t('modes.overview.connect', 'Connect Xpeed Companion')}</Link>
        </Button>
      </div>
    </div>
  );
}
