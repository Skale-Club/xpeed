import { useMemo, useState } from 'react';
import { AdvancedFold } from '@/components/ui/advanced-fold';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Map as MapIcon, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PlainSelect } from '@/components/social/social-bits';
import { useSettings } from '@/contexts/SettingsContext';
import { formatLapTime, trackPath as lapPath, type DistanceUnit } from '@/lib/sim/analysis';
import { carBoard, fastestCar, formatTimeDriven, progressFromLaps, sectorBests, summarizeLaps, validPercent, type BoardRow, type TrackBestCar } from '@/lib/sim/garage';
import { MAX_LAP_PAGES, useAllLaps, useTrackLayout } from '@/lib/sim/garage-queries';
import { trackProgress } from '@/lib/sim/progress';
import { leaderboardPath, useLeaderboardCatalog } from '@/lib/sim/social-client';
import { trackLength } from '@/lib/sim/track-length';
import { useLapFile } from '@/lib/sim/use-lap-file';
import { V1Error, useTrack, type V1TrackDetail } from '@/lib/sim/v1-client';
import { BackLink, LatestSessions } from './DetailBits';
import { DetailSkeleton, StatTile, TileGrid, TileItem, TrackShape } from './garage/bits';
import { SectorsPanel } from './garage/Sectors';
import { TrackBoard } from './garage/TrackBoard';
import { Panel, Quiet } from './overview/parts';
import { useDashFormat } from './overview/use-format';
import { lazyChart } from '@/components/LazyChart';

const ProgressChart = lazyChart(() => import('./ProgressChart').then((m) => ({ default: m.ProgressChart })), 'h-60 md:h-80');
import { GameBadge } from './session-bits';
import { TrackLayoutThumb } from './TrackLayoutThumb';
import { QueryGate } from './SimStates';
import { TrackMap } from './TrackMap';
import { useAge } from './use-age';
import { layoutFitsLap, layoutInLapFrame, localTrackSurface } from '@/lib/sim/local-track';
import { layoutGame, trackKeyOf } from '@/lib/sim/track-file';

/**
 * The layout of the track, big, with the best lap drawn on it, when Xpeed Companion has sent the layout: one lap file is read (the best lap), nothing
 * else. With a layout but no valid lap the road is drawn alone; without a layout, a quiet note says what will appear and why it is not there yet.
 */
function LayoutPanel({ detail, bestLapId }: { detail: V1TrackDetail; bestLapId: string | null }) {
  const { t } = useTranslation();
  const { track } = detail;
  const layout = useTrackLayout(track.hasLayout === false ? null : track, true);
  const file = useLapFile(layout.data ? bestLapId : null);
  const path = useMemo(() => (file.data ? lapPath(file.data, 3000) : null), [file.data]);
  const compatible = useMemo(() => {
    if (!file.data || !layout.data) return false;
    const lap = file.data;
    const map = layout.data;
    if (trackKeyOf(layoutGame(lap.header.game), lap.header.track.name, lap.header.track.variant) !==
      trackKeyOf(layoutGame(map.header.game), map.header.track.name, map.header.track.variant)) return false;
    return layoutFitsLap(map, lap.header, lap.data.x ?? [], lap.data.z ?? []);
  }, [file.data, layout.data]);

  if (track.hasLayout !== false && layout.isPending) {
    return <Skeleton className="h-56 rounded-lg md:h-72 lg:h-full lg:min-h-72" data-testid="track-layout-loading" />;
  }
  if (!layout.data) {
    return (
      <Panel title={t('modes.trackPage.layout', 'Layout and best lap')} testId="track-no-layout" className="h-full">
        <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-4 text-center">
          <MapIcon className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
          <p className="max-w-xs text-sm text-muted-foreground">{layout.isError
            ? t('modes.compare.layoutFailed', 'Track geometry could not be loaded.')
            : t('garageDash.noLayout', 'No compatible game track geometry is available for this layout yet.')}</p>
          {layout.isError && <Button size="sm" variant="outline" onClick={() => void layout.refetch()}>{t('common.retry', 'Try again')}</Button>}
        </div>
      </Panel>
    );
  }
  return (
    <Panel title={t('modes.trackPage.layout', 'Layout and best lap')} testId="track-layout-map" className="h-full">
      {path && compatible ? (
        <>
          <TrackMap lap={path} layout={file.data ? layoutInLapFrame(layout.data, file.data.header) : layout.data} className="h-56 md:h-72" />
          <p className="text-xs text-muted-foreground">{t('modes.compare.localTrack.mapHint', { surface: t(`modes.compare.localTrack.surface_${localTrackSurface(layout.data)}`) })}</p>
        </>
      ) : bestLapId && file.isPending ? (
        <Skeleton className="h-56 w-full md:h-72" />
      ) : (
        <>
          <div className="flex h-56 items-center justify-center md:h-72 rounded-md bg-muted/30">
            <TrackShape layout={layout.data} className="h-full w-full p-4" testId="track-layout-shape" strokeWidth={3} />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="track-layout-no-lap">
            {file.data && !compatible ? t('modes.compare.layoutLapMismatch', 'This lap does not match the layout and is not overlaid on it.')
              : bestLapId ? t('garageDash.layoutLapFailed', 'The layout is shown; your best lap could not be drawn on it right now.') : t('garageDash.layoutNoLap', 'The layout is shown. Your best valid lap is drawn on it once you have one.')}
          </p>
        </>
      )}
    </Panel>
  );
}

/** Where this track's leaderboard is: the board of the car you are fastest with that has public laps, or the leaderboards opened on this track. */
function LeaderboardPanel({ detail, board }: { detail: V1TrackDetail; board: readonly BoardRow[] }) {
  const { t } = useTranslation();
  const { track } = detail;
  const catalog = useLeaderboardCatalog({ kind: 'car', game: track.game, track: track.id });
  const mine = board.find((row) => catalog.items.some((entry) => entry.id === row.car.id));
  const entry = (mine ? catalog.items.find((item) => item.id === mine.car.id) : null) ?? catalog.items[0] ?? null;
  return (
    <Panel title={t('garageDash.boardTitle', 'Leaderboard')} testId="track-leaderboard">
      {catalog.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : catalog.isError ? (
        <div className="space-y-2">
          <Quiet>{t('garageDash.boardUnknown', 'See how your best lap here ranks against other drivers.')}</Quiet>
          <Button asChild size="sm"><Link to={leaderboardPath({ track: track.id, game: track.game })} data-testid="track-leaderboard-link"><Trophy className="mr-2 h-4 w-4" aria-hidden="true" />{t('garageDash.boardOpen', 'Open the leaderboard')}</Link></Button>
        </div>
      ) : !entry ? (
        <Quiet testId="track-leaderboard-none">{t('garageDash.boardNone', 'No lap on this track is on the public leaderboards yet.')}</Quiet>
      ) : (
        <div className="space-y-2">
          <Quiet>{t('garageDash.boardWith', 'See how your best lap here ranks against other drivers, with {{car}}.', { car: entry.name })}</Quiet>
          <Button asChild size="sm"><Link to={leaderboardPath({ track: track.id, car: entry.id, game: track.game })} data-testid="track-leaderboard-link"><Trophy className="mr-2 h-4 w-4" aria-hidden="true" />{t('garageDash.boardOpen', 'Open the leaderboard')}</Link></Button>
        </div>
      )}
    </Panel>
  );
}

/**
 * One track as a dashboard: the header and the layout big with the best lap on it when Xpeed Companion has sent it; the tiles (laps, valid share, best lap,
 * average valid lap, sessions, time driven, cars used, last driven); the progress over the days with a car filter; the sector bests and the theoretical lap;
 * your best lap with each car and the gap to the fastest; the leaderboard; the latest sessions. One call for the numbers, the laps for the average, the time
 * driven and the car filter; a lap file is read only for the map.
 */
export function TrackPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const format = useDashFormat();
  const age = useAge();
  // A day and a month in the person's time zone: a tile is narrow, and the line under it says how long ago that was.
  const { timezone } = useSettings();
  const shortDay = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(format.lang, { day: 'numeric', month: 'short', timeZone: timezone }).format(ms);
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  };
  const query = useTrack(id);
  const detail = query.data ?? null;
  const laps = useAllLaps({ track: id }, !!detail);
  const [carFilter, setCarFilter] = useState('');
  const notFound = query.error instanceof V1Error && query.error.code === 'track_not_found';

  const cars = useMemo(() => (detail?.bestPerCar ?? []) as TrackBestCar[], [detail]);
  const board = useMemo(() => carBoard(cars), [cars]);
  const fastest = fastestCar(board);
  const sectors = useMemo(() => sectorBests(cars, detail?.totals.bestLapMs ?? null), [cars, detail]);
  const summary = useMemo(() => summarizeLaps(laps.laps), [laps.laps]);
  const allRows = useMemo(() => (detail ? trackProgress(detail.progress) : []), [detail]);
  const filtered = carFilter !== '' && board.some((row) => row.car.id === carFilter);
  const rows = useMemo(() => (filtered ? progressFromLaps(laps.laps, carFilter) : allRows), [filtered, laps.laps, carFilter, allRows]);
  const share = detail ? validPercent(detail.totals.lapCount, detail.totals.validLapCount) : null;
  const lapsNote = laps.capped ? t('garageDash.latestLaps', 'latest {{count}} laps', { count: MAX_LAP_PAGES * 50 }) : null;

  return (
    <div className="space-y-4" data-testid="track-page">
      <BackLink to="/virtual/tracks">{t('modes.trackPage.back', 'All tracks')}</BackLink>
      {notFound ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="track-not-found">
          {t('modes.trackPage.notFound', 'This track is not in the catalog.')}
        </p>
      ) : (
        <QueryGate query={query} empty={!detail} skeleton={<DetailSkeleton label={t('common.loading', 'Loading…')} />}>
          {detail && (
            <>
              <header className="space-y-2" data-testid="track-header">
                <div className="flex flex-wrap items-center gap-1.5">
                  <GameBadge game={detail.track.game} />
                  {detail.track.hasLayout && (
                    <Badge variant="secondary" className="gap-1" data-testid="track-layout-badge"><MapIcon className="h-3 w-3" aria-hidden="true" /> {t('modes.tracks.layoutBadge', 'Layout')}</Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                    <TrackLayoutThumb trackId={detail.track.id} name={detail.track.name} className="h-16 w-16 sm:h-20 sm:w-20" />
                    <div className="min-w-0">
                      <h2 className="text-2xl font-bold leading-tight" data-testid="track-name">{detail.track.name}</h2>
                      <p className="text-sm text-muted-foreground" data-testid="track-subtitle">
                        {detail.track.lengthM ? trackLength(detail.track.lengthM, distanceUnit as DistanceUnit) : t('garageDash.lengthUnknown', 'Length not known')}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline"><Link to={`/virtual/sessions?track=${encodeURIComponent(id)}`} data-testid="track-sessions-link">{t('modes.overview.allSessions', 'All sessions')}</Link></Button>
                  </div>
                </div>
              </header>

              {/* The first level (owner, 2026-11-22: XPD-D-SIMPLE-FIRST): the best lap, how much you drove here and when; the rest is in the advanced fold. */}
              <TileGrid testId="track-tiles" columns={{ sm: 4, lg: null }}>
                    <TileItem>
                      <StatTile
                        testId="totals-best" mono label={t('modes.cars.bestLap', 'Best lap')}
                        value={detail.totals.bestLapMs !== null ? formatLapTime(detail.totals.bestLapMs) : '–'}
                        sub={fastest ? fastest.car.name : detail.totals.lapCount > 0 ? t('garageDash.noValidYet', 'No valid lap yet') : undefined}
                      />
                    </TileItem>
                    <TileItem>
                      <StatTile testId="totals-laps" label={t('modes.detail.laps', 'Laps')} value={format.number(detail.totals.lapCount)} sub={share !== null ? t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: share }) : t('modes.overview.dash.kpiValidNone', 'no laps yet')} />
                    </TileItem>
                    <TileItem>
                      <StatTile testId="totals-sessions" label={t('modes.detail.sessions', 'Sessions')} value={format.number(detail.totals.sessionCount)} />
                    </TileItem>
                    <TileItem>
                      <StatTile testId="totals-last" label={t('modes.detail.lastDriven', 'Last driven')} value={detail.totals.lastDrivenAt ? shortDay(Date.parse(detail.totals.lastDrivenAt)) : '–'} sub={detail.totals.lastDrivenAt ? age(Date.parse(detail.totals.lastDrivenAt)) : undefined} />
                    </TileItem>
              </TileGrid>

              {/* The track with its best lap drawn on it, and where you stand in the ranking. */}
              <div className="grid gap-4 lg:grid-cols-12">
                <div className="min-w-0 lg:col-span-7">
                  <LayoutPanel detail={detail} bestLapId={fastest?.lapId ?? null} />
                </div>
                <div className="min-w-0 lg:col-span-5">
                  <LeaderboardPanel detail={detail} board={board} />
                </div>
              </div>

              {detail.totals.lapCount === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="track-no-laps">{t('modes.trackPage.noLaps', 'You have not driven this track yet.')}</p>
              ) : (
                <>
                  <div className="grid gap-4 lg:grid-cols-12">
                    <div className="min-w-0 lg:col-span-12">
                      {filtered && laps.loading && laps.laps.length === 0 ? (
                        <Skeleton className="h-60 rounded-lg md:h-80" data-testid="track-progress-loading" />
                      ) : (
                        <ProgressChart
                          rows={rows}
                          testId="track-progress"
                          note={filtered && laps.capped ? <Quiet>{t('garageDash.chartFromLatest', 'Built from your latest {{count}} laps.', { count: MAX_LAP_PAGES * 50 })}</Quiet> : undefined}
                          controls={
                            board.length > 1 ? (
                              <div className="w-48 max-w-[55%]">
                                <PlainSelect
                                  className="w-full sm:w-full"
                                  label={t('modes.detail.car', 'Car')}
                                  value={filtered ? carFilter : ''}
                                  onChange={setCarFilter}
                                  options={[{ value: '', label: t('garageDash.allCars', 'All cars') }, ...board.map((row) => ({ value: row.car.id, label: row.car.name }))]}
                                  testId="track-progress-car"
                                />
                              </div>
                            ) : undefined
                          }
                        />
                      )}
                    </div>
                  </div>
                  <TrackBoard board={board} sectors={sectors} />
                </>
              )}

              <LatestSessions filters={{ track: id }} listTo={`/virtual/sessions?track=${encodeURIComponent(id)}`} hide="track" />

              {detail.totals.lapCount > 0 && (
                <AdvancedFold title={t('modes.advanced.trackTitle', 'Advanced: sectors and totals')} hint={t('modes.advanced.trackHint', 'Your best time in each sector, the valid laps, the average lap and the time driven here.')} testId="track-advanced">
                  <TileGrid testId="track-tiles-advanced" columns={{ sm: 4, lg: null }}>
                    <TileItem>
                      <StatTile testId="totals-valid" label={t('modes.detail.validLaps', 'Valid laps')} value={share !== null ? `${share}%` : '–'} sub={t('garageDash.validOf', '{{valid}} of {{laps}}', { valid: detail.totals.validLapCount, laps: detail.totals.lapCount })} />
                    </TileItem>
                    <TileItem>
                      <StatTile
                        testId="totals-average" mono label={t('garageDash.average', 'Average valid lap')} loading={laps.loading && !laps.isError}
                        value={summary.averageValidMs !== null ? formatLapTime(summary.averageValidMs) : '–'}
                        sub={lapsNote ?? t('garageDash.averageHint', 'without in and out laps')}
                      />
                    </TileItem>
                    <TileItem>
                      <StatTile
                        testId="totals-time" label={t('garageDash.timeDriven', 'Time driven')} loading={laps.loading && !laps.isError}
                        value={laps.isError ? '–' : formatTimeDriven(summary.timeMs, format.lang)} sub={lapsNote ?? undefined}
                      />
                    </TileItem>
                    <TileItem>
                      <StatTile testId="totals-cars" label={t('garageDash.carsUsed', 'Cars used')} value={format.number(detail.totals.carCount)} />
                    </TileItem>
                  </TileGrid>
                  <SectorsPanel bests={sectors} />
                </AdvancedFold>
              )}
            </>
          )}
        </QueryGate>
      )}
    </div>
  );
}
