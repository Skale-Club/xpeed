import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadMore, QueryGate } from '@/components/sim/SimStates';
import { useGames } from '@/lib/sim/games';
import { leaderboardPath, useLeaderboard, useLeaderboardCatalog, useLeaderboardMe, type BoardQuery, type CatalogEntry, type Scope } from '@/lib/sim/social-client';
import { useCars, useOverview, useTracks } from '@/lib/sim/v1-client';
import { BoardHero } from './BoardHero';
import { BoardPlace } from './BoardPlace';
import { BoardPodium } from './BoardPodium';
import { BoardTable } from './BoardTable';
import { SearchCombobox } from './SearchCombobox';
import { PlainSelect } from './social-bits';

const SCOPES: readonly Scope[] = ['public', 'friends'];
/** The catalog is read whole (up to this many pages of 50) so the pickers search every track and car that has public laps. */
const CATALOG_PAGES = 8;

/** Reads the rest of a catalog by itself: the pickers search a plain list, so they need all of it, not a "Load more". */
function useWholeCatalog(query: { kind: 'track' | 'car'; game: string | null }, enabled: boolean) {
  const catalog = useLeaderboardCatalog(query, { enabled });
  const { hasNextPage, isFetchingNextPage, fetchNextPage, data } = catalog;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && (data?.pages.length ?? 0) < CATALOG_PAGES) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, data]);
  return catalog;
}

/**
 * Virtual > Leaderboards: the best valid lap of every driver on a track with a car, ranked, for everybody (Public) or for you and your friends
 * (Friends). A hero says which board it is (the circuit's map, the car, the game, how many drivers, the fastest time and yours), the top three
 * stand on a podium, a card says where you stand (the gap to the podium and to the leader, and where you sit in the field) and the table ranks
 * everyone with a bar for the gap to the leader. The track and the car are searched in two combo boxes (the ones you drove first, then the
 * others with public laps) and live in the address with the game and the scope, so a board can be linked to. Ties share a rank.
 */
export function LeaderboardScreen() {
  const { t } = useTranslation();
  const games = useGames();
  const [params, setParams] = useSearchParams();
  const tracks = useTracks();
  const cars = useCars();
  const overview = useOverview();
  const latest = overview.data?.latestSessions[0] ?? null;

  const scope: Scope = params.get('scope') === 'friends' ? 'friends' : 'public';
  const urlTrack = params.get('track');
  const urlCar = params.get('car');
  const urlGame = params.get('game');

  // The tracks and cars with public laps, whether or not you drove them (the ones you drove come first in the pickers).
  const catalogGame = urlGame ?? latest?.game ?? tracks.items[0]?.game ?? null;
  // (Asked once the game is known, so it is one read for the game and not one for every game first.)
  const gameKnown = !tracks.isPending && !overview.isPending;
  const trackCatalog = useWholeCatalog({ kind: 'track', game: catalogGame }, gameKnown);
  const carCatalog = useWholeCatalog({ kind: 'car', game: catalogGame }, gameKnown);

  // The pair you drove last, else the track and the car you drove last, else the first track and car with public laps; an address that names them wins.
  const defaults = useMemo(() => {
    const track = tracks.items.find((entry) => entry.id === latest?.track.id) ?? tracks.items[0] ?? trackCatalog.items[0] ?? null;
    const car = cars.items.find((entry) => entry.id === latest?.car.id) ?? cars.items.find((entry) => entry.game === track?.game) ?? cars.items[0]
      ?? carCatalog.items.find((entry) => entry.game === track?.game) ?? carCatalog.items[0] ?? null;
    return { track: track?.id ?? null, car: car?.id ?? null };
  }, [tracks.items, cars.items, trackCatalog.items, carCatalog.items, latest]);
  const track = urlTrack ?? defaults.track;
  const car = urlCar ?? defaults.car;
  const game = urlGame ?? [...tracks.items, ...trackCatalog.items].find((entry) => entry.id === track)?.game ?? [...cars.items, ...carCatalog.items].find((entry) => entry.id === car)?.game ?? null;

  const query: BoardQuery = { track, car, scope, game };
  const board = useLeaderboard(query);
  const me = useLeaderboardMe(query);

  const gameIds = useMemo(
    () => [...new Set([...tracks.items, ...cars.items, ...trackCatalog.items, ...carCatalog.items].map((entry) => entry.game))],
    [tracks.items, cars.items, trackCatalog.items, carCatalog.items],
  );
  // What you drove first, then the others that have public laps (a heading tells them apart once there are both).
  const optionsOf = (driven: readonly { id: string; name: string; game: string }[], others: readonly CatalogEntry[]) => {
    const mine = driven.filter((entry) => !game || entry.game === game);
    const rest = others.filter((entry) => (!game || entry.game === game) && !driven.some((own) => own.id === entry.id));
    const grouped = mine.length > 0 && rest.length > 0;
    return [
      ...mine.map((entry) => ({ value: entry.id, label: entry.name, ...(grouped ? { group: t('social.leaderboard.drivenGroup', 'Driven by you') } : {}) })),
      ...rest.map((entry) => ({ value: entry.id, label: entry.name, ...(grouped ? { group: t('social.leaderboard.otherGroup', 'With public laps') } : {}) })),
    ];
  };
  const trackOptions = optionsOf(tracks.items, trackCatalog.items);
  const carOptions = optionsOf(cars.items, carCatalog.items);

  // Keep the address in step with what is on screen: choosing writes it, the defaults are written once they are known.
  const write = (next: { track?: string | null; car?: string | null; scope?: Scope; game?: string | null }) => {
    const merged = { track, car, scope, game, ...next };
    setParams(leaderboardParamsOf(merged), { replace: true });
  };
  useEffect(() => {
    if (!urlTrack && !urlCar && defaults.track && defaults.car) {
      setParams(leaderboardParamsOf({ track: defaults.track, car: defaults.car, scope, game }), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.track, defaults.car]);

  const pickGame = (next: string) => {
    const nextTrack = tracks.items.find((entry) => entry.game === next) ?? trackCatalog.items.find((entry) => entry.game === next);
    const nextCar = cars.items.find((entry) => entry.game === next) ?? carCatalog.items.find((entry) => entry.game === next);
    write({ game: next, track: nextTrack?.id ?? null, car: nextCar?.id ?? null });
  };

  const drivenNothing = tracks.items.length === 0 || cars.items.length === 0;
  const catalogNothing = trackCatalog.items.length === 0 || carCatalog.items.length === 0;
  const loadingChoices = tracks.isPending || cars.isPending || (drivenNothing && (trackCatalog.isPending || carCatalog.isPending));
  const nothingDriven = !loadingChoices && !tracks.isError && !cars.isError && drivenNothing && catalogNothing && !(urlTrack && urlCar);
  const empty = board.entries.length === 0;

  const driven = tracks.items.find((entry) => entry.id === track);
  const nameOf = (options: ReadonlyArray<{ value: string; label: string }>, id: string | null) => options.find((option) => option.value === id)?.label ?? '';
  const meta = board.meta;

  const scopeTabs = (
    <Tabs value={scope} onValueChange={(value) => write({ scope: value === 'friends' ? 'friends' : 'public' })}>
      <TabsList aria-label={t('social.leaderboard.scope', 'Who to rank')}>
        {SCOPES.map((entry) => (
          <TabsTrigger key={entry} value={entry} data-testid={`scope-${entry}`}>
            {entry === 'public' ? t('social.leaderboard.public', 'Public') : t('social.leaderboard.friends', 'Friends')}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  return (
    <div className="space-y-4" data-testid="leaderboards">
      <QueryGate
        query={tracks}
        empty={nothingDriven}
        emptyNode={
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="board-nothing-driven">
            <p>{t('social.leaderboard.nothingDriven', 'Drive a lap first: the leaderboards show the tracks and cars you have driven.')}</p>
            <Button asChild size="sm" className="mt-3"><Link to="/virtual/companion">{t('modes.states.connect', 'Connect it to your account')}</Link></Button>
          </div>
        }
        skeleton={<Skeleton className="h-64 w-full rounded-xl" />}
      >
        <BoardHero
          trackId={track}
          trackName={meta?.track.name ?? nameOf(trackOptions, track)}
          lengthM={meta?.track.lengthM ?? driven?.lengthM}
          layoutId={driven?.hasLayout === false ? null : driven?.layoutId}
          carName={meta?.car.name ?? nameOf(carOptions, car)}
          carClass={meta?.car.class}
          game={meta?.game ?? game}
          total={me.data?.total ?? null}
          leaderMs={board.entries[0]?.timeMs ?? null}
          myMs={me.data?.me?.timeMs ?? null}
          scopeTabs={scopeTabs}
        >
          <FilterBar data-testid="board-pickers">
            {gameIds.length > 1 && (
              <PlainSelect
                label={t('social.leaderboard.game', 'Game')}
                value={game ?? ''}
                onChange={pickGame}
                options={gameIds.map((id) => ({ value: id, label: games.name(id) }))}
                className="sm:w-52"
                testId="board-game"
              />
            )}
            <SearchCombobox
              label={t('social.leaderboard.track', 'Track')}
              value={track ?? ''}
              onChange={(value) => write({ track: value })}
              options={trackOptions}
              placeholder={t('social.leaderboard.searchTrack', 'Search a track')}
              emptyText={t('social.leaderboard.noMatch', 'Nothing matches what you typed.')}
              moreText={t('social.leaderboard.keepTyping', 'More than this match: keep typing to narrow the list.')}
              className="sm:min-w-[14rem] sm:flex-1"
              testId="board-track"
            />
            <SearchCombobox
              label={t('social.leaderboard.car', 'Car')}
              value={car ?? ''}
              onChange={(value) => write({ car: value })}
              options={carOptions}
              placeholder={t('social.leaderboard.searchCar', 'Search a car')}
              emptyText={t('social.leaderboard.noMatch', 'Nothing matches what you typed.')}
              moreText={t('social.leaderboard.keepTyping', 'More than this match: keep typing to narrow the list.')}
              className="sm:min-w-[14rem] sm:flex-1"
              testId="board-car"
            />
          </FilterBar>
        </BoardHero>

        {track && car && (
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="order-2 min-w-0 space-y-4 lg:order-1 lg:col-span-8">
              <QueryGate
                query={board}
                empty={empty}
                emptyNode={
                  <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="board-empty">
                    {scope === 'public'
                      ? t('social.leaderboard.emptyPublic', 'No public laps for this track and car yet.')
                      : t('social.leaderboard.emptyFriends', 'No laps from you or your friends for this track and car yet.')}
                  </div>
                }
                skeleton={<Skeleton className="h-72 w-full rounded-xl" />}
              >
                <BoardPodium entries={board.entries} />
                <BoardTable entries={board.entries} />
                <LoadMore hasNextPage={!!board.hasNextPage} isFetchingNextPage={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()} />
              </QueryGate>
            </div>
            <div className="order-1 min-w-0 space-y-4 lg:order-2 lg:col-span-4">
              <div className="lg:sticky lg:top-4">
                <BoardPlace me={me} scope={scope} entries={board.entries} />
              </div>
            </div>
          </div>
        )}
      </QueryGate>
    </div>
  );
}

function leaderboardParamsOf(value: { track: string | null; car: string | null; scope: Scope; game: string | null }): URLSearchParams {
  const url = new URL(`http://x${leaderboardPath({ track: value.track ?? undefined, car: value.car ?? undefined, game: value.game ?? undefined, scope: value.scope === 'friends' ? 'friends' : undefined })}`);
  return url.searchParams;
}
