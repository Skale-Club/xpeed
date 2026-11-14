import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { signedSeconds, type TrackConsistency, type TrackRow } from '@/lib/sim/garage';
import { trackPath } from '@/lib/sim/routes';
import { Panel, Quiet } from '../overview/parts';
import { useWhen } from '../use-when';

/**
 * Your best valid lap with this car on each track (the most driven first), with the gap to your best lap on that track with any car: "Your best" when
 * this car holds it. Each track opens its page, each lap its analysis. `pbsReady` says whether the personal bests have been read (until then the gap is a skeleton).
 */
export function CarTracks({ rows, pbsReady }: { rows: readonly TrackRow[]; pbsReady: boolean }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  return (
    <Panel title={t('modes.carPage.bestPerTrack', 'Best lap on each track')} testId="best-per-track">
      {rows.length === 0 ? (
        <Quiet>{t('garageDash.noTracksYet', 'No track has a lap with this car yet.')}</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('garageDash.tracksCaption', 'Your best valid lap with this car on each track, with the gap to your best lap there with any car.')}</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('modes.detail.track', 'Track')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('modes.cars.bestLap', 'Best valid lap')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('garageDash.gapToBest', 'To your best')}</th>
                <th scope="col" className="hidden py-1.5 pr-3 text-right font-medium sm:table-cell">{t('modes.detail.laps', 'Laps')}</th>
                <th scope="col" className="hidden py-1.5 pr-3 font-medium md:table-cell">{t('modes.detail.when', 'Set on')}</th>
                <th scope="col" className="py-1.5 font-medium"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((entry) => (
                <tr key={entry.track.id} className="hover:bg-muted/40" data-testid="best-track-row">
                  <td className="max-w-[6.5rem] py-2 pr-2 align-middle sm:max-w-[18rem] sm:pr-3">
                    <Link to={trackPath(entry.track.id)} className="block truncate rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="best-track-link">{entry.track.name}</Link>
                    {entry.bestMs === null && <p className="mt-0.5 text-xs text-muted-foreground">{t('garageDash.noValidYet', 'No valid lap yet')}</p>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right align-middle font-mono tabular-nums" data-testid="best-track-time">{entry.bestMs !== null ? formatLapTime(entry.bestMs) : '–'}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right align-middle font-mono text-xs tabular-nums" data-testid="best-track-gap">
                    {entry.bestMs === null ? (
                      <span className="text-muted-foreground">–</span>
                    ) : entry.deltaToPbMs === null ? (
                      pbsReady ? <span className="text-muted-foreground">–</span> : <Skeleton className="ml-auto h-4 w-12" />
                    ) : entry.deltaToPbMs === 0 ? (
                      <Badge variant="secondary" className="font-sans text-success" data-testid="best-track-pb">{t('garageDash.yourBest', 'Your best')}</Badge>
                    ) : (
                      <span className="text-muted-foreground" title={t('garageDash.gapHint', 'Your best lap on this track is with another car.')}>{signedSeconds(entry.deltaToPbMs)}</span>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pr-3 text-right align-middle tabular-nums sm:table-cell">{entry.lapCount}</td>
                  <td className="hidden whitespace-nowrap py-2 pr-3 align-middle text-xs text-muted-foreground md:table-cell">{entry.achievedAt ? when(Date.parse(entry.achievedAt)) : '–'}</td>
                  <td className="whitespace-nowrap py-2 text-right align-middle">
                    {entry.lapId && (
                      <Button asChild size="sm" variant="outline" className="h-8 px-2">
                        <Link to={compareUrl(entry.lapId)} aria-label={`${t('modes.session.analyze', 'Analyze')}: ${entry.track.name}`} title={t('modes.session.analyze', 'Analyze')} data-testid="best-track-analyze">
                          <LineChart className="h-4 w-4" aria-hidden="true" />
                        </Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const MAX_ROWS = 6;

/**
 * How steady you are on each track with this car: the spread of your valid laps (the standard deviation, in and out laps left out) as a bar and in
 * seconds, the more laps first. A track needs three clean laps to have one. The laps come from the lap list, so with a very long history it says it
 * covers the latest ones.
 */
export function CarConsistency({ rows, loading, capped, count }: { rows: readonly TrackConsistency[]; loading: boolean; capped: boolean; count: number }) {
  const { t } = useTranslation();
  const shown = rows.slice(0, MAX_ROWS);
  const widest = Math.max(1, ...shown.map((row) => row.spreadMs ?? 0));
  return (
    <Panel title={t('garageDash.consistencyTitle', 'Consistency by track')} testId="car-consistency">
      <p className="text-xs text-muted-foreground">{t('garageDash.consistencyHint', 'How much your valid laps differ from each other. Smaller is steadier. In and out laps are left out.')}</p>
      {loading ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading', 'Loading…')}>
          <Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" />
        </div>
      ) : shown.length === 0 ? (
        <Quiet testId="car-consistency-empty">{t('garageDash.consistencyEmpty', 'Your consistency shows once you have valid laps with this car.')}</Quiet>
      ) : (
        <ul className="space-y-3">
          {shown.map((row) => (
            <li key={row.track.id} className="space-y-1" data-testid="car-consistency-row">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <Link to={trackPath(row.track.id)} className="min-w-0 truncate rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.track.name}</Link>
                <span className="shrink-0 font-mono text-xs tabular-nums" data-testid="car-consistency-spread">
                  {row.spreadMs !== null ? t('garageDash.spreadValue', '±{{seconds}} s', { seconds: (row.spreadMs / 1000).toFixed(2) }) : t('garageDash.spreadNeeds', 'needs 3 laps')}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full bg-primary" style={{ width: row.spreadMs !== null ? `${Math.max(4, (row.spreadMs / widest) * 100)}%` : '0%' }} />
              </div>
              <p className="text-xs text-muted-foreground">{t('garageDash.cleanLaps', '{{count}} clean laps', { count: row.laps })}</p>
            </li>
          ))}
        </ul>
      )}
      {capped && !loading && <Quiet>{t('garageDash.chartFromLatest', 'Built from your latest {{count}} laps.', { count })}</Quiet>}
    </Panel>
  );
}

