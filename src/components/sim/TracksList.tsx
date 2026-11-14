import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Map as MapIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PlainSelect } from '@/components/social/social-bits';
import { useSettings } from '@/contexts/SettingsContext';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime, type DistanceUnit } from '@/lib/sim/analysis';
import { carBoard, fastestCar, isListSort, matchesSearch, pbTrend, runningBest, sortListed, utcToday, validPercent, type ListSort } from '@/lib/sim/garage';
import { MAX_LAP_PAGES, useOnScreen, useTrackDetail, useTrackLayout } from '@/lib/sim/garage-queries';
import { useGames } from '@/lib/sim/games';
import { trackPath } from '@/lib/sim/routes';
import { trackLength } from '@/lib/sim/track-length';
import { hasSyncedLayout, useAccountLayouts } from '@/lib/sim/track-layout-match';
import { useOverview, useTracks, type V1TrackItem } from '@/lib/sim/v1-client';
import { FilterSelect } from './FilterSelect';
import { CardGridSkeleton, NoResults, SearchField, SummaryStrip, TimeSparkline, ToggleChip, TrackShape } from './garage/bits';
import { PbTrendChip } from './garage/Trend';
import { GameBadge } from './session-bits';
import { SimCarIdentity } from './SimCarIdentity';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { useDashFormat } from './overview/use-format';
import { useWhen } from './use-when';

/**
 * One track as a card: the game and, when Xpeed Companion has sent the layout, its shape; the length; the laps, sessions and cars; the best valid lap
 * with the car that set it, how it moved in the last 30 days and a sparkline of the best so far. The shape and the progress are read when the card
 * comes on screen (one small file, one detail), never for the cards far down the list.
 */
function TrackCard({ track, layout, unit, today }: { track: V1TrackItem; layout: boolean; unit: DistanceUnit; today: string }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const format = useDashFormat();
  const [attach, seen] = useOnScreen<HTMLAnchorElement>();
  const detail = useTrackDetail(track.id, seen);
  const shape = useTrackLayout(layout ? { game: track.game, name: track.name, layoutId: track.layoutId } : null, seen);
  const days = useMemo(() => detail.data?.progress.bestPerDay ?? [], [detail.data]);
  const trend = useMemo(() => pbTrend(days, today), [days, today]);
  const spark = useMemo(() => runningBest(days), [days]);
  const car = useMemo(() => (detail.data ? fastestCar(carBoard(detail.data.bestPerCar))?.car ?? null : null), [detail.data]);
  const share = validPercent(track.lapCount, track.validLapCount);

  return (
    <Link ref={attach} to={trackPath(track.id)} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="track-link">
      <Card className="h-full bg-card border-border transition-colors hover:bg-muted/30" data-testid="track">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <GameBadge game={track.game} />
                {layout && (
                  <Badge variant="secondary" className="gap-1" data-testid="track-layout-badge" title={t('modes.tracks.layoutTitle', 'The track map is available: the lap is drawn on it')}>
                    <MapIcon className="h-3 w-3" aria-hidden="true" /> {t('modes.tracks.layoutBadge', 'Layout')}
                  </Badge>
                )}
              </div>
              <h3 className="line-clamp-2 text-base font-semibold leading-snug" title={track.name}>{track.name}</h3>
              <p className="text-xs text-muted-foreground" data-testid="track-length">
                {track.lengthM ? trackLength(track.lengthM, unit) : t('garageDash.lengthUnknown', 'Length not known')}
              </p>
            </div>
            {layout && (
              <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-muted/40" data-testid="track-preview">
                {shape.data ? <TrackShape layout={shape.data} className="h-full w-full p-1" testId="track-preview-shape" /> : shape.isPending && seen ? <Skeleton className="h-full w-full" /> : <MapIcon className="h-5 w-5 text-muted-foreground/50" aria-hidden="true" />}
              </div>
            )}
            <ChevronRight className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
          </div>

          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div className="min-w-0" data-testid="track-laps">
              <dt className="text-muted-foreground">{t('modes.detail.laps', 'Laps')}</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {format.number(track.lapCount)}
                {share !== null && <span className="block font-normal text-muted-foreground">{t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: share })}</span>}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('modes.detail.sessions', 'Sessions')}</dt>
              <dd className="font-medium tabular-nums text-foreground" data-testid="track-sessions">{format.number(track.sessionCount)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('modes.detail.cars', 'Cars')}</dt>
              <dd className="font-medium tabular-nums text-foreground">{format.number(track.carCount)}</dd>
            </div>
          </dl>

          <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0 space-y-0.5" data-testid="track-best">
              <p className="text-xs text-muted-foreground">{t('modes.cars.bestLap', 'Best valid lap')}</p>
              <p className="font-mono text-lg font-semibold tabular-nums leading-tight" data-testid="track-best-time">{track.bestLapMs !== null ? formatLapTime(track.bestLapMs) : '–'}</p>
              {track.bestLapMs === null ? (
                <p className="text-xs text-muted-foreground">{t('garageDash.noValidYet', 'No valid lap yet')}</p>
              ) : car ? (
                <p className="min-w-0 text-xs text-muted-foreground" data-testid="track-best-car"><SimCarIdentity name={car.name} logoClassName="h-4 w-4" /></p>
              ) : detail.isPending && seen ? (
                <Skeleton className="h-4 w-28" />
              ) : null}
            </div>
            {track.bestLapMs !== null && (
              <div className="w-28 shrink-0 space-y-1 text-right">
                {detail.data ? (
                  <>
                    <TimeSparkline values={spark} color={CHART_PALETTE.yellow} />
                    <div className="flex justify-end"><PbTrendChip trend={trend} /></div>
                  </>
                ) : detail.isPending && seen ? (
                  <Skeleton className="h-9 w-full" />
                ) : null}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('modes.cars.lastDriven', 'Last driven {{when}}', { when: when(Date.parse(track.lastDrivenAt)) })}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

const SORT_LABELS = (t: (key: string, fallback: string) => string): Array<{ value: ListSort; label: string }> => [
  { value: 'recent', label: t('garageDash.sortRecent', 'Recently driven') },
  { value: 'most', label: t('garageDash.sortMost', 'Most driven') },
  { value: 'az', label: t('garageDash.sortAz', 'Name (A to Z)') },
];

/**
 * Virtual > Tracks: the tracks the person has driven, as cards. A header with the game, a search by name, a sort (recently driven, most driven, A to Z)
 * and "has a layout"; a strip with what the list adds up to; the cards, a page at a time (the rest is read by itself when a search, a sort or the layout
 * filter needs the whole list). A track opens its own page.
 */
export function TracksList() {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const games = useGames();
  const format = useDashFormat();
  const [params, setParams] = useSearchParams();
  const game = params.get('game') ?? '';
  const search = params.get('q') ?? '';
  const sort: ListSort = isListSort(params.get('sort')) ? (params.get('sort') as ListSort) : 'recent';
  const layoutOnly = params.get('layout') === '1';
  const overview = useOverview();
  const tracks = useTracks(game ? { game } : {});
  // The server says it (`hasLayout`); only a server that predates it makes the page read the layouts and match them itself.
  const layouts = useAccountLayouts(tracks.items.some((track) => track.hasLayout === undefined));
  const today = useMemo(() => utcToday(), []);
  const hasLayout = (track: V1TrackItem) => track.hasLayout ?? (!!layouts && hasSyncedLayout(layouts, track));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const clear = () => {
    const next = new URLSearchParams(params);
    for (const key of ['q', 'layout', 'sort']) next.delete(key);
    setParams(next, { replace: true });
  };

  const narrowed = search.trim() !== '' || layoutOnly || sort !== 'recent';
  // A search, a sort or the layout filter is about the whole list: the pages that are still on the server are read now.
  const pages = tracks.data?.pages.length ?? 0;
  useEffect(() => {
    if (narrowed && tracks.hasNextPage && !tracks.isFetching && pages < MAX_LAP_PAGES) void tracks.fetchNextPage();
  }, [narrowed, tracks, pages]);

  const shown = useMemo(
    () => sortListed(tracks.items.filter((track) => matchesSearch(track.name, search) && (!layoutOnly || hasLayout(track))), sort),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks.items, search, layoutOnly, sort, layouts],
  );
  const more = tracks.hasNextPage ? '+' : '';
  const laps = shown.reduce((total, track) => total + track.lapCount, 0);
  const valid = shown.reduce((total, track) => total + track.validLapCount, 0);
  const sessions = shown.reduce((total, track) => total + track.sessionCount, 0);
  const withLayout = shown.filter(hasLayout).length;
  const mostDriven = [...shown].sort((p, q) => q.lapCount - p.lapCount)[0];

  return (
    <div className="space-y-4" data-testid="tracks-list">
      <p className="text-sm text-muted-foreground">{t('modes.tracks.listIntro', 'The tracks you have driven. Open one to see your progress on it and your best lap with each car.')}</p>
      {(tracks.isPending || tracks.items.length > 0 || game !== '' || narrowed) && (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label={t('garageDash.filters', 'Filter the tracks')}>
        <div className="sm:col-span-2 lg:col-span-1">
          <SearchField label={t('garageDash.search', 'Search by name')} value={search} onChange={(value) => setParam('q', value)} placeholder={t('garageDash.searchTracks', 'Monza, Spa...')} testId="filter-search" />
        </div>
        <FilterSelect
          label={t('modes.sessions.filterGame', 'Game')}
          allLabel={t('modes.sessions.all', 'All')}
          value={game}
          onChange={(value) => setParam('game', value)}
          options={(overview.data?.lapsPerGame ?? []).map((entry) => ({ value: entry.game, label: games.name(entry.game) }))}
          testId="filter-game"
        />
        <PlainSelect
          label={t('garageDash.sort', 'Sort by')}
          value={sort}
          onChange={(value) => setParam('sort', value === 'recent' ? '' : value)}
          options={SORT_LABELS(t)}
          testId="sort-select"
        />
        <div className="flex flex-col justify-end">
          <ToggleChip pressed={layoutOnly} onChange={(on) => setParam('layout', on ? '1' : '')} testId="filter-layout">
            <MapIcon className="h-4 w-4" aria-hidden="true" /> {t('garageDash.hasLayout', 'Has a layout')}
          </ToggleChip>
        </div>
      </div>
      )}
      <QueryGate
        query={tracks}
        empty={tracks.items.length === 0}
        skeleton={<CardGridSkeleton label={t('common.loading', 'Loading…')} />}
        emptyNode={
          game ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="tracks-no-match">{t('modes.tracks.noMatch', 'No track of this game yet.')}</p>
          ) : (
            <CompanionInvite testId="tracks-empty" body={t('modes.tracks.emptyAccount', 'No tracks yet. Install Xpeed Companion and connect it to your account: the tracks you drive show up here.')} />
          )
        }
      >
        <div className="space-y-4">
          <SummaryStrip
            testId="tracks-summary"
            items={[
              { id: 'tracks', label: t('garageDash.sumTracks', 'Tracks'), value: `${format.number(shown.length)}${more}`, sub: t('garageDash.sumWithLayout', '{{count}} with a layout', { count: withLayout }) },
              { id: 'laps', label: t('modes.detail.laps', 'Laps'), value: `${format.number(laps)}${more}`, sub: laps > 0 ? t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: validPercent(laps, valid) }) : undefined },
              { id: 'sessions', label: t('modes.detail.sessions', 'Sessions'), value: `${format.number(sessions)}${more}` },
              { id: 'most', label: t('garageDash.sumMost', 'Most driven'), value: mostDriven ? mostDriven.name : '–', sub: mostDriven ? t('modes.overview.dash.lapsN', '{{count}} laps', { count: mostDriven.lapCount }) : undefined },
            ]}
          />
          {shown.length === 0 ? (
            <NoResults testId="tracks-no-results" onClear={clear} clearLabel={t('garageDash.clearFilters', 'Clear the filters')}>
              {tracks.hasNextPage ? t('garageDash.noResultsLoading', 'No track matches yet. The rest of your tracks are still loading.') : t('garageDash.noResultsTracks', 'No track matches your search.')}
            </NoResults>
          ) : (
            <div className="grid gap-3 md:grid-cols-2" data-testid="tracks-grid">
              {shown.map((track) => (
                <TrackCard key={track.id} track={track} layout={hasLayout(track)} unit={distanceUnit as DistanceUnit} today={today} />
              ))}
            </div>
          )}
          <LoadMore hasNextPage={!!tracks.hasNextPage} isFetchingNextPage={tracks.isFetchingNextPage} onClick={() => void tracks.fetchNextPage()} />
        </div>
      </QueryGate>
    </div>
  );
}
