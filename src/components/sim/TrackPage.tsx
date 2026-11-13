import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSettings } from '@/contexts/SettingsContext';
import { formatLapTime, trackPath as lapPath, type DistanceUnit } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useGames } from '@/lib/sim/games';
import { trackProgress } from '@/lib/sim/progress';
import { carPath } from '@/lib/sim/routes';
import { layoutGame, type TrackFile } from '@/lib/sim/track-file';
import { trackLength } from '@/lib/sim/track-length';
import { useLapFile } from '@/lib/sim/use-lap-file';
import { useLayoutFinder } from '@/lib/sim/use-track-layouts';
import { V1Error, useTrack } from '@/lib/sim/v1-client';
import { BackLink, LatestSessions, Stat } from './DetailBits';
import { ProgressChart } from './ProgressChart';
import { ListSkeleton, QueryGate } from './SimStates';
import { SimCarIdentity } from './SimCarIdentity';
import { TrackMap } from './TrackMap';
import { useWhen } from './use-when';

/**
 * The layout of the track with the track's best lap drawn on it, when Xpeed Companion has sent the layout: one lap file is read (the
 * best lap), nothing else. Without a layout, or without a valid lap, nothing is drawn.
 */
function TrackLayoutMap({ game, name, bestLapId }: { game: string; name: string; bestLapId: string | null }) {
  const { t } = useTranslation();
  const { findLayout } = useLayoutFinder();
  const [layout, setLayout] = useState<TrackFile | null>(null);
  useEffect(() => {
    let live = true;
    findLayout(layoutGame(game), name).then(
      (found) => live && setLayout(found),
      () => live && setLayout(null),
    );
    return () => {
      live = false;
    };
  }, [findLayout, game, name]);
  const file = useLapFile(layout ? bestLapId : null);
  const path = useMemo(() => (file.data ? lapPath(file.data, 3000) : null), [file.data]);
  if (!layout || !bestLapId || !path) return null;
  return (
    <Card className="bg-card border-border" data-testid="track-layout-map">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.trackPage.layout', 'Layout and best lap')}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <TrackMap lap={path} layout={layout} />
        <p className="mt-1 text-xs text-muted-foreground">{t('modes.trackPage.layoutHint', 'The road between its edges, with your best valid lap on this track in yellow.')}</p>
      </CardContent>
    </Card>
  );
}

/**
 * One track: the totals, the progress over the days (the best valid lap of each day and the laps driven), the best lap with each car,
 * the latest sessions here and, when Xpeed Companion has sent it, the layout with the best lap on it. One call for the numbers; a lap
 * file is read only for the map.
 */
export function TrackPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const games = useGames();
  const when = useWhen('date');
  const query = useTrack(id);
  const detail = query.data ?? null;
  const rows = useMemo(() => (detail ? trackProgress(detail.progress) : []), [detail]);
  const notFound = query.error instanceof V1Error && query.error.code === 'track_not_found';
  const bestLapId = detail?.bestPerCar.find((entry) => entry.lapId !== null && entry.bestMs === detail.totals.bestLapMs)?.lapId ?? detail?.bestPerCar.find((entry) => entry.lapId !== null)?.lapId ?? null;

  return (
    <div className="space-y-4" data-testid="track-page">
      <BackLink to="/virtual/tracks">{t('modes.trackPage.back', 'All tracks')}</BackLink>
      {notFound ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="track-not-found">
          {t('modes.trackPage.notFound', 'This track is not in the catalog.')}
        </p>
      ) : (
        <QueryGate query={query} empty={!detail} skeleton={<ListSkeleton rows={3} />}>
          {detail && (
            <>
              <Card className="bg-card border-border" data-testid="track-header">
                <CardContent className="space-y-3 p-4">
                  <div>
                    <h2 className="truncate text-lg font-bold">{detail.track.name}</h2>
                    <p className="text-sm text-muted-foreground">
                      {games.name(detail.track.game)}
                      {detail.track.lengthM ? ` · ${trackLength(detail.track.lengthM, distanceUnit as DistanceUnit)}` : ''}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                    <Stat label={t('modes.detail.laps', 'Laps')} testId="totals-laps">{detail.totals.lapCount}</Stat>
                    <Stat label={t('modes.detail.validLaps', 'Valid laps')} testId="totals-valid">{detail.totals.validLapCount}</Stat>
                    <Stat label={t('modes.detail.sessions', 'Sessions')} testId="totals-sessions">{detail.totals.sessionCount}</Stat>
                    <Stat label={t('modes.detail.cars', 'Cars')} testId="totals-cars">{detail.totals.carCount}</Stat>
                    <Stat label={t('modes.cars.bestLap', 'Best valid lap')} testId="totals-best">{detail.totals.bestLapMs !== null ? formatLapTime(detail.totals.bestLapMs) : '–'}</Stat>
                    <Stat label={t('modes.detail.lastDriven', 'Last driven')} testId="totals-last">{detail.totals.lastDrivenAt ? when(Date.parse(detail.totals.lastDrivenAt)) : '–'}</Stat>
                  </div>
                </CardContent>
              </Card>

              {rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="track-no-laps">{t('modes.trackPage.noLaps', 'You have not driven this track yet.')}</p>
              ) : (
                <ProgressChart rows={rows} testId="track-progress" />
              )}

              {detail.bestPerCar.length > 0 && (
                <Card className="bg-card border-border" data-testid="best-per-car">
                  <CardHeader className="pb-1">
                    <CardTitle className="text-sm font-semibold">{t('modes.trackPage.bestPerCar', 'Best lap with each car')}</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground">
                            <th scope="col" className="py-1.5 pr-3 font-normal">{t('modes.detail.car', 'Car')}</th>
                            <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t('modes.cars.bestLap', 'Best valid lap')}</th>
                            <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t('modes.detail.laps', 'Laps')}</th>
                            <th scope="col" className="py-1.5 pr-3 font-normal">{t('modes.detail.when', 'Set on')}</th>
                            <th scope="col" className="py-1.5 font-normal"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.bestPerCar.map((entry) => (
                            <tr key={entry.car.id} className="border-t border-border" data-testid="best-car-row">
                              <td className="max-w-[14rem] py-1.5 pr-3">
                                <Link to={carPath(entry.car.id)} className="inline-flex min-w-0 hover:underline" data-testid="best-car-link">
                                  <SimCarIdentity name={entry.car.name} />
                                </Link>
                              </td>
                              <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums" data-testid="best-car-time">{entry.bestMs !== null ? formatLapTime(entry.bestMs) : '–'}</td>
                              <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{entry.lapCount}</td>
                              <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{entry.achievedAt ? when(Date.parse(entry.achievedAt)) : '–'}</td>
                              <td className="whitespace-nowrap py-1.5 text-right">
                                {entry.lapId && (
                                  <Button asChild size="sm" variant="outline" className="h-8 px-2">
                                    <Link to={compareUrl(entry.lapId)} aria-label={`${t('modes.session.analyze', 'Analyze')}: ${entry.car.name}`} title={t('modes.session.analyze', 'Analyze')} data-testid="best-car-analyze">
                                      <LineChart className="h-4 w-4" />
                                    </Link>
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              <LatestSessions filters={{ track: id }} listTo={`/virtual/sessions?track=${encodeURIComponent(id)}`} hide="track" />
              <TrackLayoutMap game={detail.track.game} name={detail.track.name} bestLapId={bestLapId} />
            </>
          )}
        </QueryGate>
      )}
    </div>
  );
}
