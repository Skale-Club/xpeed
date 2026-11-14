import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useSettings } from '@/contexts/SettingsContext';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { buildKpis, formatDistance, formatDuration, validShare, type Change, type Kpi, type KpiId } from '@/lib/sim/dashboard';
import type { V1Stats } from '@/lib/sim/v1-client';
import { Sparkline } from './parts';
import { useDashFormat } from './use-format';

const ORDER: readonly KpiId[] = ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars'];

/** How the tile says the change: an arrow and a percent in the muted colour (more driving is not good or bad), "n/a" when the period before is empty. */
function ChangeLine({ change }: { change: Change }) {
  const { t } = useTranslation();
  if (change.trend === 'none') {
    return (
      <span className="text-xs text-muted-foreground" data-testid="kpi-change" data-trend="none" title={t('modes.overview.dash.changeNoneHint', 'There is nothing in the period before to compare with.')}>
        {t('modes.overview.dash.changeNone', 'n/a')}
      </span>
    );
  }
  const Icon = change.trend === 'up' ? ArrowUp : change.trend === 'down' ? ArrowDown : Minus;
  const text =
    change.trend === 'up' ? t('modes.overview.dash.changeUp', '{{percent}}% more than the period before', { percent: change.percent })
    : change.trend === 'down' ? t('modes.overview.dash.changeDown', '{{percent}}% less than the period before', { percent: change.percent })
    : t('modes.overview.dash.changeSame', 'the same as the period before');
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" data-testid="kpi-change" data-trend={change.trend} title={text}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span aria-hidden="true">{change.percent}%</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * The six tiles: the value for the range, the change against the period of the same length before it, and a sparkline of the per-day values.
 * With no stats (an account with no laps at all) the frames are the same and every value is a dash: nothing pretends to be data.
 */
export function KpiTiles({ stats }: { stats: V1Stats | null }) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const format = useDashFormat();
  const kpis = useMemo(() => (stats ? new Map<KpiId, Kpi>(buildKpis(stats).map((kpi) => [kpi.id, kpi])) : null), [stats]);
  const labels: Record<KpiId, string> = {
    laps: t('modes.overview.dash.kpiLaps', 'Laps'),
    time: t('modes.overview.dash.kpiTime', 'Time driven'),
    distance: t('modes.overview.dash.kpiDistance', 'Distance'),
    sessions: t('modes.overview.dash.kpiSessions', 'Sessions'),
    personalBests: t('modes.overview.dash.kpiBests', 'Personal bests set'),
    tracksCars: t('modes.overview.dash.kpiTracksCars', 'Tracks & cars driven'),
  };
  const share = stats ? validShare(stats.totals) : null;

  const value = (id: KpiId): string => {
    if (!stats) return '–';
    const { totals } = stats;
    switch (id) {
      case 'laps': return format.number(totals.laps);
      case 'time': return formatDuration(totals.timeMs, format.lang);
      case 'distance': return formatDistance(totals.distanceM, distanceUnit, format.lang);
      case 'sessions': return format.number(totals.sessions);
      case 'personalBests': return format.number(totals.personalBests);
      case 'tracksCars': return `${format.number(totals.tracks)} · ${format.number(totals.cars)}`;
    }
  };
  const sub = (id: KpiId): string | null => {
    if (id === 'laps') return stats && share !== null ? t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: share }) : stats ? t('modes.overview.dash.kpiValidNone', 'no laps yet') : null;
    if (id === 'tracksCars') return stats ? `${t('modes.overview.dash.kpiTracksN', '{{count}} tracks', { count: stats.totals.tracks })} · ${t('modes.overview.dash.kpiCarsN', '{{count}} cars', { count: stats.totals.cars })}` : null;
    return null;
  };

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-testid="kpi-tiles" data-empty={stats ? undefined : 'true'}>
      {ORDER.map((id) => {
        const kpi = kpis?.get(id);
        return (
          <li key={id}>
            <Card className="h-full space-y-1.5 bg-card p-3" data-testid={`kpi-${id}`}>
              <p className="truncate text-xs font-medium text-muted-foreground">{labels[id]}</p>
              <p className="truncate text-xl font-semibold tabular-nums leading-tight" data-testid={`kpi-${id}-value`}>{value(id)}</p>
              <p className="min-h-4 truncate text-xs text-muted-foreground" data-testid={`kpi-${id}-sub`}>{sub(id) ?? ' '}</p>
              <div className="flex items-center justify-between gap-2">
                {kpi ? <ChangeLine change={kpi.change} /> : <span className="text-xs" aria-hidden="true">&nbsp;</span>}
              </div>
              {kpi ? <Sparkline values={kpi.series} color={CHART_PALETTE.blue} /> : <div className="h-7 border-b border-dashed border-border" aria-hidden="true" />}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
