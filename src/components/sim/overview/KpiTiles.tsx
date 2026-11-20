import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Flag, Gamepad2, Map as MapIcon, Minus, Route, Star, Timer, type LucideIcon } from 'lucide-react';
import { AreaSparkline } from '@/components/ui/chart-kit';
import { StatTile } from '@/components/ui/stat-tile';
import { accentColor, type Accent } from '@/lib/chart-theme';
import { useSettings } from '@/contexts/SettingsContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { buildKpis, formatDistance, formatDuration, validShare, type Change, type Kpi, type KpiId } from '@/lib/sim/dashboard';
import type { V1Stats } from '@/lib/sim/v1-client';
import { useDashFormat } from './use-format';

const ORDER: readonly KpiId[] = ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars'];
/** On a phone four tiles are enough: what you did, not where. */
const PHONE_ORDER: readonly KpiId[] = ['sessions', 'time', 'laps', 'personalBests'];

/**
 * Each tile's colour and icon (Dashboards 2027, phase 3, owner 2026-11-20: colour in breaks, not yellow everywhere). Yellow is the
 * personal bests', because they are records.
 */
const LOOK: Record<KpiId, { accent: Accent; icon: LucideIcon }> = {
  laps: { accent: 'blue', icon: Flag },
  time: { accent: 'purple', icon: Timer },
  distance: { accent: 'green', icon: Route },
  sessions: { accent: 'sky', icon: Gamepad2 },
  personalBests: { accent: 'yellow', icon: Star },
  tracksCars: { accent: 'pink', icon: MapIcon },
};

/** How the tile says the change: a small pill with an arrow and a percent in the muted colour (more driving is not good or bad), "n/a" when the period before is empty. */
const CHIP = 'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.07] px-1.5 text-2xs font-semibold tabular-nums';

function ChangeLine({ change }: { change: Change }) {
  const { t } = useTranslation();
  if (change.trend === 'none') {
    return (
      <span className={`${CHIP} text-muted-foreground`} data-testid="kpi-change" data-trend="none" title={t('modes.overview.dash.changeNoneHint', 'There is nothing in the period before to compare with.')}>
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
    <span className={`${CHIP} text-muted-foreground`} data-testid="kpi-change" data-trend={change.trend} title={text}>
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
  const mobile = useIsMobile();
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
    // A bento on wider screens: Laps as the big number on the left, two rows of tiles beside it, Tracks & cars spanning the end of the second row.
    // A phone gets four tiles two by two.
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3.5 lg:grid-cols-[1.3fr_1fr_1fr_1fr]" data-testid="kpi-tiles" data-empty={stats ? undefined : 'true'}>
      {(mobile ? PHONE_ORDER : ORDER).map((id) => {
        const kpi = kpis?.get(id);
        const { accent, icon } = LOOK[id];
        const hero = !mobile && id === 'laps';
        return (
          <StatTile
            key={id}
            size={hero ? 'hero' : 'feature'}
            label={labels[id]}
            value={value(id)}
            icon={icon}
            accent={accent}
            hint={sub(id) ?? undefined}
            badge={kpi ? <ChangeLine change={kpi.change} /> : undefined}
            testId={`kpi-${id}`}
            itemClassName={id === 'tracksCars' ? 'sm:col-span-3 lg:col-span-2' : undefined}
            footer={kpi
              ? <AreaSparkline values={kpi.series} color={accentColor(accent)} strong={hero} className={hero ? 'h-24' : 'h-7'} testId="sparkline" />
              : <div className="h-7 border-b border-dashed border-border" aria-hidden="true" />}
          />
        );
      })}
    </ul>
  );
}
