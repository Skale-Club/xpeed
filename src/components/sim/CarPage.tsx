import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { PlainSelect } from '@/components/social/social-bits';
import { formatLapTime } from '@/lib/sim/analysis';
import { consistencyByTrack, formatTimeDriven, mostDrivenTrack, pbByTrack, summarizeLaps, trackRows, validPercent } from '@/lib/sim/garage';
import { MAX_LAP_PAGES, useAllLaps, useAllPbs } from '@/lib/sim/garage-queries';
import { carProgress, carProgressTracks } from '@/lib/sim/progress';
import { V1Error, useCar } from '@/lib/sim/v1-client';
import { BackLink, LatestSessions } from './DetailBits';
import { CarConsistency, CarTracks } from './garage/CarTracks';
import { DetailSkeleton, StatTile, TileGrid, TileItem } from './garage/bits';
import { useDashFormat } from './overview/use-format';
import { ProgressChart } from './ProgressChart';
import { GameBadge } from './session-bits';
import { SimCarIdentity } from './SimCarIdentity';
import { QueryGate } from './SimStates';
import { useGames } from '@/lib/sim/games';
import { useWhen } from './use-when';

/**
 * One car as a dashboard: its identity (the logo, the class, the brand, the game); the tiles (laps, valid share, tracks driven, sessions, time driven,
 * the best lap on the track driven the most); the progress over the days on one track (chosen from the tracks it has a daily best on); the consistency
 * on each track; the best lap on each track with the gap to your best there; the latest sessions with it. One call for the numbers, the laps for the
 * time driven and the consistency, the personal bests for the gaps; no lap file is read.
 */
export function CarPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const games = useGames();
  const format = useDashFormat();
  const when = useWhen('date');
  const query = useCar(id);
  const detail = query.data ?? null;
  const laps = useAllLaps({ car: id }, !!detail);
  const pbs = useAllPbs(detail ? { game: detail.car.game } : {}, !!detail);
  // The line of the chart is the best lap of each day on one track: the one with the most days, unless another is picked.
  const progressTracks = useMemo(() => (detail ? carProgressTracks(detail.progress) : []), [detail]);
  const [picked, setPicked] = useState<string | null>(null);
  const progressTrack = progressTracks.find((track) => track.id === picked)?.id ?? progressTracks[0]?.id ?? null;
  const rows = useMemo(() => (detail ? carProgress(detail.progress, progressTrack) : []), [detail, progressTrack]);
  const tracks = useMemo(() => (detail ? trackRows(detail.bestPerTrack, pbs.isError ? null : pbByTrack(pbs.pbs)) : []), [detail, pbs.pbs, pbs.isError]);
  const top = mostDrivenTrack(tracks);
  const summary = useMemo(() => summarizeLaps(laps.laps), [laps.laps]);
  const consistency = useMemo(() => consistencyByTrack(laps.laps), [laps.laps]);
  const notFound = query.error instanceof V1Error && query.error.code === 'car_not_found';
  const share = detail ? validPercent(detail.totals.lapCount, detail.totals.validLapCount) : null;
  const lapsLoading = laps.loading && !laps.isError;
  const progressName = progressTracks.find((track) => track.id === progressTrack)?.name;

  return (
    <div className="space-y-4" data-testid="car-page">
      <BackLink to="/virtual/cars">{t('modes.carPage.back', 'All cars')}</BackLink>
      {notFound ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="car-not-found">
          {t('modes.carPage.notFound', 'This car is not in the catalog.')}
        </p>
      ) : (
        <QueryGate query={query} empty={!detail} skeleton={<DetailSkeleton label={t('common.loading', 'Loading…')} tiles={6} />}>
          {detail && (
            <>
              <header className="space-y-2" data-testid="car-header">
                <div className="flex flex-wrap items-center gap-1.5">
                  <GameBadge game={detail.car.game} />
                  {detail.car.class && <Badge variant="outline" data-testid="car-class">{detail.car.class}</Badge>}
                  {detail.car.brand && <span className="text-xs text-muted-foreground" data-testid="car-brand">{detail.car.brand}</span>}
                </div>
                <h2 className="min-w-0 text-2xl font-bold leading-tight"><SimCarIdentity name={detail.car.name} logoClassName="h-12 w-12" className="gap-3" /></h2>
                <p className="text-sm text-muted-foreground" data-testid="car-subtitle">
                  {games.name(detail.car.game)}
                  {detail.totals.lastDrivenAt ? ` · ${t('modes.cars.lastDriven', 'Last driven {{when}}', { when: when(Date.parse(detail.totals.lastDrivenAt)) })}` : ''}
                </p>
              </header>

              <TileGrid testId="car-tiles">
                <TileItem>
                  <StatTile testId="totals-laps" label={t('modes.detail.laps', 'Laps')} value={format.number(detail.totals.lapCount)} sub={share !== null ? t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: share }) : t('modes.overview.dash.kpiValidNone', 'no laps yet')} />
                </TileItem>
                <TileItem>
                  <StatTile testId="totals-valid" label={t('modes.detail.validLaps', 'Valid laps')} value={share !== null ? `${share}%` : '–'} sub={t('garageDash.validOf', '{{valid}} of {{laps}}', { valid: detail.totals.validLapCount, laps: detail.totals.lapCount })} />
                </TileItem>
                <TileItem>
                  <StatTile testId="totals-tracks" label={t('garageDash.tracksDriven', 'Tracks driven')} value={format.number(detail.totals.trackCount)} />
                </TileItem>
                <TileItem>
                  <StatTile testId="totals-sessions" label={t('modes.detail.sessions', 'Sessions')} value={format.number(detail.totals.sessionCount)} />
                </TileItem>
                <TileItem>
                  <StatTile
                    testId="totals-time" label={t('garageDash.timeDriven', 'Time driven')} loading={lapsLoading}
                    value={laps.isError ? '–' : formatTimeDriven(summary.timeMs, format.lang)}
                    sub={laps.capped ? t('garageDash.latestLaps', 'latest {{count}} laps', { count: MAX_LAP_PAGES * 50 }) : undefined}
                  />
                </TileItem>
                <TileItem>
                  <StatTile
                    testId="totals-best" mono label={t('modes.cars.bestLap', 'Best valid lap')}
                    value={top && top.bestMs !== null ? formatLapTime(top.bestMs) : '–'}
                    sub={top ? (top.bestMs !== null ? t('garageDash.bestOnTopTrack', '{{track}}, the most driven', { track: top.track.name }) : t('garageDash.noValidYet', 'No valid lap yet')) : undefined}
                  />
                </TileItem>
              </TileGrid>

              {detail.totals.lapCount === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="car-no-laps">{t('modes.carPage.noLaps', 'You have not driven this car yet.')}</p>
              ) : (
                <>
                  <div className="grid gap-4 lg:grid-cols-12">
                    <div className="min-w-0 lg:col-span-8">
                      <ProgressChart
                        rows={rows}
                        testId="car-progress"
                        title={progressName ? t('garageDash.progressOn', 'Progress on {{track}}', { track: progressName }) : undefined}
                        controls={
                          progressTracks.length > 1 ? (
                            <div className="w-48 max-w-[55%]">
                              <PlainSelect
                                label={t('modes.carPage.progressTrack', 'Best lap on')}
                                value={progressTrack ?? ''}
                                onChange={setPicked}
                                options={progressTracks.map((track) => ({ value: track.id, label: track.name }))}
                                testId="car-progress-track"
                              />
                            </div>
                          ) : undefined
                        }
                      />
                    </div>
                    <div className="min-w-0 lg:col-span-4">
                      <CarConsistency rows={consistency} loading={lapsLoading && laps.laps.length === 0} capped={laps.capped} count={MAX_LAP_PAGES * 50} />
                    </div>
                  </div>
                  <CarTracks rows={tracks} pbsReady={!pbs.loading} />
                </>
              )}

              <LatestSessions filters={{ car: id }} listTo={`/virtual/sessions?car=${encodeURIComponent(id)}`} hide="car" />
            </>
          )}
        </QueryGate>
      )}
    </div>
  );
}

