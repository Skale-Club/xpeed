import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PlainSelect } from '@/components/social/social-bits';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { isListSort, lapsPerDaySeries, matchesSearch, mostDrivenTrack, normalizeName, sortListed, trackRows, utcToday, validPercent, type ListSort } from '@/lib/sim/garage';
import { MAX_LAP_PAGES, useCarDetail, useOnScreen } from '@/lib/sim/garage-queries';
import { useGames } from '@/lib/sim/games';
import { carPath } from '@/lib/sim/routes';
import { useCars, useOverview, type V1CarItem } from '@/lib/sim/v1-client';
import { FilterSelect } from './FilterSelect';
import { CardGridSkeleton, NoResults, SearchField, SummaryStrip } from './garage/bits';
import { Sparkline, Quiet } from './overview/parts';
import { useDashFormat } from './overview/use-format';
import { GameBadge } from './session-bits';
import { SimCarIdentity } from './SimCarIdentity';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { useWhen } from './use-when';

/** The brand when the API gives one and the name does not already start with it ("Ferrari" under "Ferrari 488 GT3" would say nothing). */
const brandNote = (car: V1CarItem): string | null => (car.brand && !normalizeName(car.name).startsWith(normalizeName(car.brand)) ? car.brand : null);

/**
 * One car as a card: its identity (the brand logo when the name says the brand), the class and the game; the laps, tracks and sessions; the best valid lap
 * on the track it was driven on the most; and the laps of each of the last 30 days as a sparkline. The best lap and the sparkline come from the car's
 * detail, read when the card comes on screen.
 */
function CarCard({ car, today }: { car: V1CarItem; today: string }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const format = useDashFormat();
  const [attach, seen] = useOnScreen<HTMLAnchorElement>();
  const detail = useCarDetail(car.id, seen);
  const top = useMemo(() => (detail.data ? mostDrivenTrack(trackRows(detail.data.bestPerTrack, null)) : null), [detail.data]);
  const series = useMemo(() => (detail.data ? lapsPerDaySeries(detail.data.progress.lapsPerDay, today, 30) : []), [detail.data, today]);
  const recent = series.reduce((total, value) => total + value, 0);
  const share = validPercent(car.lapCount, car.validLapCount);
  const brand = brandNote(car);

  return (
    <Link ref={attach} to={carPath(car.id)} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="car-link">
      <Card className="h-full bg-card border-border transition-colors hover:bg-muted/30" data-testid="cars-car">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1.5">
              <div className="min-w-0 text-base font-semibold"><SimCarIdentity name={car.name} logoClassName="h-8 w-8" /></div>
              <div className="flex flex-wrap items-center gap-1.5">
                <GameBadge game={car.game} />
                {car.class && <Badge variant="outline" data-testid="car-class">{car.class}</Badge>}
                {brand && <span className="text-xs text-muted-foreground" data-testid="car-brand">{brand}</span>}
              </div>
            </div>
            <ChevronRight className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
          </div>

          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div className="min-w-0" data-testid="car-laps">
              <dt className="text-muted-foreground">{t('modes.detail.laps', 'Laps')}</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {format.number(car.lapCount)}
                {share !== null && <span className="block font-normal text-muted-foreground">{t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: share })}</span>}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('modes.detail.tracks', 'Tracks')}</dt>
              <dd className="font-medium tabular-nums text-foreground" data-testid="car-tracks">{format.number(car.trackCount)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('modes.detail.sessions', 'Sessions')}</dt>
              <dd className="font-medium tabular-nums text-foreground">{format.number(car.sessionCount)}</dd>
            </div>
          </dl>

          <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0 space-y-0.5" data-testid="car-best">
              <p className="truncate text-xs text-muted-foreground">
                {top ? t('garageDash.bestOn', 'Best valid lap on {{track}}', { track: top.track.name }) : t('modes.cars.bestLap', 'Best valid lap')}
              </p>
              {top ? (
                <p className="font-mono text-lg font-semibold tabular-nums leading-tight" data-testid="car-best-time">{top.bestMs !== null ? formatLapTime(top.bestMs) : '–'}</p>
              ) : detail.data || detail.isError || car.bestLapMs === null ? (
                <p className="font-mono text-lg font-semibold tabular-nums leading-tight" data-testid="car-best-time">{car.bestLapMs !== null ? formatLapTime(car.bestLapMs) : '–'}</p>
              ) : (
                <Skeleton className="h-6 w-24" />
              )}
              {car.bestLapMs === null && <p className="text-xs text-muted-foreground">{t('garageDash.noValidYet', 'No valid lap yet')}</p>}
            </div>
            <div className="w-28 shrink-0 space-y-0.5 text-right" data-testid="car-activity">
              {detail.data ? (
                recent > 0 ? (
                  <>
                    <Sparkline values={series} color={CHART_PALETTE.blue} />
                    <p className="text-xs text-muted-foreground">{t('garageDash.last30', 'Laps, last 30 days')}</p>
                  </>
                ) : (
                  <Quiet testId="car-activity-none">{t('garageDash.noLast30', 'No laps in the last 30 days')}</Quiet>
                )
              ) : detail.isPending && seen ? (
                <Skeleton className="h-9 w-full" />
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('modes.cars.lastDriven', 'Last driven {{when}}', { when: when(Date.parse(car.lastDrivenAt)) })}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Virtual > Game cars: the cars driven, as cards. A header with the game, the class, a search by name and a sort (recently driven, most driven, A to Z);
 * a strip with what the list adds up to; the cards, a page at a time (the rest is read by itself when a search, a sort or a class needs the whole list).
 * A car opens its own page.
 */
export function SimCars() {
  const { t } = useTranslation();
  const games = useGames();
  const format = useDashFormat();
  const [params, setParams] = useSearchParams();
  const game = params.get('game') ?? '';
  const search = params.get('q') ?? '';
  const cls = params.get('class') ?? '';
  const sort: ListSort = isListSort(params.get('sort')) ? (params.get('sort') as ListSort) : 'recent';
  const overview = useOverview();
  const query = useCars(game ? { game } : {});
  const today = useMemo(() => utcToday(), []);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const clear = () => {
    const next = new URLSearchParams(params);
    for (const key of ['q', 'class', 'sort']) next.delete(key);
    setParams(next, { replace: true });
  };

  const narrowed = search.trim() !== '' || cls !== '' || sort !== 'recent';
  const pages = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (narrowed && query.hasNextPage && !query.isFetching && pages < MAX_LAP_PAGES) void query.fetchNextPage();
  }, [narrowed, query, pages]);

  const classes = useMemo(() => [...new Set(query.items.flatMap((car) => (car.class ? [car.class] : [])))].sort((p, q) => p.localeCompare(q)), [query.items]);
  const shown = useMemo(
    () => sortListed(query.items.filter((car) => matchesSearch(`${car.name} ${car.brand ?? ''}`, search) && (!cls || car.class === cls)), sort),
    [query.items, search, cls, sort],
  );
  const more = query.hasNextPage ? '+' : '';
  const laps = shown.reduce((total, car) => total + car.lapCount, 0);
  const valid = shown.reduce((total, car) => total + car.validLapCount, 0);
  const sessions = shown.reduce((total, car) => total + car.sessionCount, 0);
  const mostDriven = [...shown].sort((p, q) => q.lapCount - p.lapCount)[0];

  return (
    <div className="space-y-4" data-testid="cars">
      <p className="text-sm text-muted-foreground">{t('garageDash.carsIntro', 'The cars you have driven. Open one to see your best lap on each track and how you improve with it.')}</p>
      {(query.isPending || query.items.length > 0 || game !== '' || narrowed) && (
      <div className={`grid gap-3 sm:grid-cols-2 ${classes.length > 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`} role="search" aria-label={t('garageDash.filtersCars', 'Filter the cars')}>
        <div className="sm:col-span-2 lg:col-span-1">
          <SearchField label={t('garageDash.search', 'Search by name')} value={search} onChange={(value) => setParam('q', value)} placeholder={t('garageDash.searchCars', 'Ferrari, GT3...')} testId="filter-search" />
        </div>
        <FilterSelect
          label={t('modes.sessions.filterGame', 'Game')}
          allLabel={t('modes.sessions.all', 'All')}
          value={game}
          onChange={(value) => setParam('game', value)}
          options={(overview.data?.lapsPerGame ?? []).map((entry) => ({ value: entry.game, label: games.name(entry.game) }))}
          testId="filter-game"
        />
        {classes.length > 0 && (
          <FilterSelect label={t('garageDash.class', 'Class')} allLabel={t('modes.sessions.all', 'All')} value={cls} onChange={(value) => setParam('class', value)} options={classes.map((name) => ({ value: name, label: name }))} testId="filter-class" />
        )}
        <PlainSelect
          label={t('garageDash.sort', 'Sort by')}
          value={sort}
          onChange={(value) => setParam('sort', value === 'recent' ? '' : value)}
          options={[
            { value: 'recent', label: t('garageDash.sortRecent', 'Recently driven') },
            { value: 'most', label: t('garageDash.sortMost', 'Most driven') },
            { value: 'az', label: t('garageDash.sortAz', 'Name (A to Z)') },
          ]}
          testId="sort-select"
        />
      </div>
      )}
      <QueryGate
        query={query}
        empty={query.items.length === 0}
        skeleton={<CardGridSkeleton label={t('common.loading', 'Loading…')} />}
        emptyNode={
          game ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="cars-no-match">{t('garageDash.noCarsGame', 'No car of this game yet.')}</p>
          ) : (
            <CompanionInvite testId="cars-empty" body={t('modes.cars.empty', 'No cars yet. Install Xpeed Companion and connect it to your account: the cars you drive show up here.')} />
          )
        }
      >
        <div className="space-y-4">
          <SummaryStrip
            testId="cars-summary"
            items={[
              { id: 'cars', label: t('garageDash.sumCars', 'Cars'), value: `${format.number(shown.length)}${more}` },
              { id: 'laps', label: t('modes.detail.laps', 'Laps'), value: `${format.number(laps)}${more}`, sub: laps > 0 ? t('modes.overview.dash.kpiValid', '{{percent}}% valid', { percent: validPercent(laps, valid) }) : undefined },
              { id: 'sessions', label: t('modes.detail.sessions', 'Sessions'), value: `${format.number(sessions)}${more}` },
              { id: 'most', label: t('garageDash.sumMost', 'Most driven'), value: mostDriven ? mostDriven.name : '–', sub: mostDriven ? t('modes.overview.dash.lapsN', '{{count}} laps', { count: mostDriven.lapCount }) : undefined },
            ]}
          />
          {shown.length === 0 ? (
            <NoResults testId="cars-no-results" onClear={clear} clearLabel={t('garageDash.clearFilters', 'Clear the filters')}>
              {query.hasNextPage ? t('garageDash.noResultsLoadingCars', 'No car matches yet. The rest of your cars are still loading.') : t('garageDash.noResultsCars', 'No car matches your search.')}
            </NoResults>
          ) : (
            <div className="grid gap-3 md:grid-cols-2" data-testid="cars-grid">
              {shown.map((car) => <CarCard key={car.id} car={car} today={today} />)}
            </div>
          )}
          <LoadMore hasNextPage={!!query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
        </div>
      </QueryGate>
    </div>
  );
}
