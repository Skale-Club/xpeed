import { useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatLapTime } from '@/lib/sim/analysis';
import { isOnline } from '@/lib/sim/companion';
import { STATS_RANGES, type StatsRange, type V1Overview } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { useAge } from '../use-age';
import { useNow } from '../use-now';

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

/**
 * With a computer paired: one slim chip, "Online" when the server heard from one of them in the last 3 minutes (the heartbeat of a running Xpeed
 * Companion) and "Offline" when not, the computer and the last lap received, linking to the Companion screen.
 */
export function CompanionChip({ overview }: { overview: V1Overview }) {
  const { t } = useTranslation();
  const age = useAge();
  const now = useNow();
  const devices = overview.companion.devices;
  const lastLap = overview.companion.lastLap;
  const newest = [...devices].sort((p, q) => Date.parse(q.lastSeenAt ?? q.pairedAt) - Date.parse(p.lastSeenAt ?? p.pairedAt))[0];
  if (!newest) return null;
  const online = devices.some((device) => isOnline(device.lastSeenAt, now));
  return (
    <Link
      to="/virtual/companion"
      title={t('modes.overview.manage', 'Manage Xpeed Companion')}
      className="flex w-fit max-w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="overview-companion"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-medium" data-testid="overview-connected" data-state={online ? 'online' : 'offline'}>
        <span className={cn('h-2 w-2 rounded-full', online ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
        {online ? t('communityDash.companion.online', 'Online') : t('communityDash.companion.offline', 'Offline')}
      </span>
      <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 font-medium" data-testid="overview-device">{newest.name}{devices.length > 1 ? ` +${devices.length - 1}` : ''}</span>
      <span className="min-w-0 truncate text-muted-foreground" data-testid="overview-last-lap">
        {lastLap
          ? t('modes.overview.dash.chipLastLap', 'last lap {{time}} · {{track}} · {{car}} · {{when}}', {
              time: formatLapTime(lastLap.timeMs), track: lastLap.track?.name ?? '–', car: lastLap.car?.name ?? '–', when: age(Date.parse(lastLap.startedAt)),
            })
          : t('modes.overview.noLapYet', 'No lap received yet. Drive a lap with a game open.')}
      </span>
    </Link>
  );
}

/** Stands in for the status line while the first read runs. */
export const CompanionStatusSkeleton = () => <Skeleton className="h-9 w-full rounded-lg sm:w-96" data-testid="overview-companion-loading" />;
