import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useGames } from '@/lib/sim/games';
import { carProgress } from '@/lib/sim/progress';
import { trackPath } from '@/lib/sim/routes';
import { V1Error, useCar } from '@/lib/sim/v1-client';
import { BackLink, LatestSessions, Stat } from './DetailBits';
import { ProgressChart } from './ProgressChart';
import { ListSkeleton, QueryGate } from './SimStates';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

/**
 * One car: the totals, the best valid lap on each track (each opening its track page), the laps driven each day and the latest
 * sessions with it. One call for the numbers; no lap file is read.
 */
export function CarPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen('date');
  const query = useCar(id);
  const detail = query.data ?? null;
  const rows = useMemo(() => (detail ? carProgress(detail.progress) : []), [detail]);
  const notFound = query.error instanceof V1Error && query.error.code === 'car_not_found';

  return (
    <div className="space-y-4" data-testid="car-page">
      <BackLink to="/virtual/cars">{t('modes.carPage.back', 'All cars')}</BackLink>
      {notFound ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="car-not-found">
          {t('modes.carPage.notFound', 'This car is not in the catalog.')}
        </p>
      ) : (
        <QueryGate query={query} empty={!detail} skeleton={<ListSkeleton rows={3} />}>
          {detail && (
            <>
              <Card className="bg-card border-border" data-testid="car-header">
                <CardContent className="space-y-3 p-4">
                  <div className="space-y-1">
                    <h2 className="min-w-0 text-lg font-bold"><SimCarIdentity name={detail.car.name} /></h2>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <span>{games.name(detail.car.game)}</span>
                      {detail.car.class && <Badge variant="outline" data-testid="car-class">{detail.car.class}</Badge>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                    <Stat label={t('modes.detail.laps', 'Laps')} testId="totals-laps">{detail.totals.lapCount}</Stat>
                    <Stat label={t('modes.detail.validLaps', 'Valid laps')} testId="totals-valid">{detail.totals.validLapCount}</Stat>
                    <Stat label={t('modes.detail.sessions', 'Sessions')} testId="totals-sessions">{detail.totals.sessionCount}</Stat>
                    <Stat label={t('modes.detail.tracks', 'Tracks')} testId="totals-tracks">{detail.totals.trackCount}</Stat>
                    <Stat label={t('modes.cars.bestLap', 'Best valid lap')} testId="totals-best">{detail.totals.bestLapMs !== null ? formatLapTime(detail.totals.bestLapMs) : '–'}</Stat>
                    <Stat label={t('modes.detail.lastDriven', 'Last driven')} testId="totals-last">{detail.totals.lastDrivenAt ? when(Date.parse(detail.totals.lastDrivenAt)) : '–'}</Stat>
                  </div>
                </CardContent>
              </Card>

              {detail.bestPerTrack.length > 0 && (
                <Card className="bg-card border-border" data-testid="best-per-track">
                  <CardHeader className="pb-1">
                    <CardTitle className="text-sm font-semibold">{t('modes.carPage.bestPerTrack', 'Best lap on each track')}</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground">
                            <th scope="col" className="py-1.5 pr-3 font-normal">{t('modes.detail.track', 'Track')}</th>
                            <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t('modes.cars.bestLap', 'Best valid lap')}</th>
                            <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t('modes.detail.laps', 'Laps')}</th>
                            <th scope="col" className="py-1.5 pr-3 font-normal">{t('modes.detail.when', 'Set on')}</th>
                            <th scope="col" className="py-1.5 font-normal"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.bestPerTrack.map((entry) => (
                            <tr key={entry.track.id} className="border-t border-border" data-testid="best-track-row">
                              <td className="max-w-[14rem] py-1.5 pr-3">
                                <Link to={trackPath(entry.track.id)} className="block truncate hover:underline" data-testid="best-track-link">{entry.track.name}</Link>
                              </td>
                              <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums" data-testid="best-track-time">{entry.bestMs !== null ? formatLapTime(entry.bestMs) : '–'}</td>
                              <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{entry.lapCount}</td>
                              <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{entry.achievedAt ? when(Date.parse(entry.achievedAt)) : '–'}</td>
                              <td className="whitespace-nowrap py-1.5 text-right">
                                {entry.lapId && (
                                  <Button asChild size="sm" variant="outline" className="h-8 px-2">
                                    <Link to={compareUrl(entry.lapId)} aria-label={`${t('modes.session.analyze', 'Analyze')}: ${entry.track.name}`} title={t('modes.session.analyze', 'Analyze')} data-testid="best-track-analyze">
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

              {rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="car-no-laps">{t('modes.carPage.noLaps', 'You have not driven this car yet.')}</p>
              ) : (
                <ProgressChart rows={rows} testId="car-progress" />
              )}

              <LatestSessions filters={{ car: id }} listTo={`/virtual/sessions?car=${encodeURIComponent(id)}`} hide="car" />
            </>
          )}
        </QueryGate>
      )}
    </div>
  );
}
