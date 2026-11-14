import { useTranslation } from 'react-i18next';
import { formatLapTime } from '@/lib/sim/analysis';
import { formatDuration } from '@/lib/sim/dashboard';
import type { SessionsSummary } from '@/lib/sim/sessions-view';
import { StatTile, TileGrid } from '../StatTile';
import { useDashFormat } from '../overview/use-format';

/**
 * The numbers of the sessions the filters let through: how many sessions, laps and time, and either the best lap (when the filters name one track and
 * one car, the only case where lap times can be compared) or how many tracks and cars are in the set. With more pages still to read the counts say
 * "so far" (a "+").
 */
export function SessionsSummaryStrip({ summary, showBest, more }: { summary: SessionsSummary; showBest: boolean; more: boolean }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const plus = more ? '+' : '';
  return (
    <TileGrid testId="sessions-summary">
      <StatTile
        testId="sum-sessions"
        label={t('sessionsDash.summary.sessions', 'Sessions')}
        value={`${format.number(summary.sessions)}${plus}`}
        sub={more ? t('sessionsDash.summary.soFar', 'so far: load more for the rest') : t('sessionsDash.summary.inView', 'in this view')}
      />
      <StatTile testId="sum-laps" label={t('sessionsDash.summary.laps', 'Laps')} value={`${format.number(summary.laps)}${plus}`} />
      <StatTile
        testId="sum-time"
        label={t('sessionsDash.summary.time', 'Session time')}
        value={`${formatDuration(summary.timeMs, format.lang)}${plus}`}
        hint={t('sessionsDash.summary.timeHint', 'The sessions from their start to their end, as Xpeed Companion saw them.')}
      />
      {showBest ? (
        <StatTile
          testId="sum-best"
          label={t('sessionsDash.summary.best', 'Best lap')}
          value={summary.bestLapMs !== null ? formatLapTime(summary.bestLapMs) : '–'}
          mono
          tone={summary.bestLapMs !== null ? 'accent' : 'plain'}
          sub={summary.bestLapMs !== null ? t('sessionsDash.summary.bestSub', 'on this track, in this car') : t('sessionsDash.summary.noValid', 'no valid lap yet')}
        />
      ) : (
        <StatTile
          testId="sum-pairs"
          label={t('sessionsDash.summary.tracksCars', 'Tracks · cars')}
          value={`${format.number(summary.tracks)} · ${format.number(summary.cars)}`}
          hint={t('sessionsDash.summary.pickBest', 'Pick a track and a car to see the best lap.')}
        />
      )}
    </TileGrid>
  );
}
