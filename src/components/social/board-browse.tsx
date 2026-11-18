// The way into the leaderboards: a game, then a track, then a car, then the board. Every list is made from what exists: the tracks and cars
// you drove (your account) and the ones with public laps (the shared catalog), so a new track or car shows up here as soon as it has laps.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SimCarIdentity } from '@/components/sim/SimCarIdentity';
import { GameBadge } from '@/components/sim/session-bits';
import { ErrorPanel, QueryGate } from '@/components/sim/SimStates';
import { useReadAllPages } from '@/components/sim/use-read-all-pages';
import { useSettings } from '@/contexts/SettingsContext';
import { formatLapTime, type DistanceUnit } from '@/lib/sim/analysis';
import { formatDistance } from '@/lib/sim/dashboard';
import { useGames } from '@/lib/sim/games';
import { leaderboardPath, trackPagePath, useLeaderboardCatalog, type CatalogQuery, type Scope } from '@/lib/sim/social-client';
import { useTrack, useTracks } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { TrackThumb } from './TrackThumb';

/** The catalog is read whole (up to this many pages of 50): the lists are short, and they are searched on the device. */
const CATALOG_PAGES = 8;
/** From this many tracks on, the list gets a search box. */
const SEARCH_FROM = 9;

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

/** Reads the rest of a catalog by itself: the lists below are plain lists, so they need all of it, not a "Load more". */
export function useWholeCatalog(query: CatalogQuery, enabled = true) {
  const catalog = useLeaderboardCatalog(query, { enabled });
  const { hasNextPage, isFetchingNextPage, fetchNextPage, data } = catalog;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && (data?.pages.length ?? 0) < CATALOG_PAGES) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, data]);
  return catalog;
}

/** Where the person is in the leaderboards: game › track › car. Every step but the last opens its list. */
export function BoardCrumbs({ scope, game, track, car }: {
  scope: Scope;
  game: string | null;
  track?: { id: string; name: string } | null;
  car?: { name: string } | null;
}) {
  const { t } = useTranslation();
  const games = useGames();
  const scoped = scope === 'friends' ? ('friends' as const) : undefined;
  const steps: Array<{ label: string; to?: string }> = [
    { label: t('social.leaderboard.allGames', 'All games'), to: leaderboardPath({ scope: scoped }) },
    ...(game ? [{ label: games.name(game), to: track ? leaderboardPath({ game, scope: scoped }) : undefined }] : []),
    ...(track ? [{ label: track.name || '–', to: car ? leaderboardPath({ game: game ?? undefined, track: track.id, scope: scoped }) : undefined }] : []),
    ...(car ? [{ label: car.name || '–' }] : []),
  ];
  return (
    <nav aria-label={t('social.leaderboard.crumbs', 'Where you are in the leaderboards')} data-testid="board-crumbs">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {steps.map((step, index) => (
          <li key={`${index}-${step.label}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            {step.to ? (
              <Link to={step.to} className={`truncate underline-offset-2 hover:text-foreground hover:underline ${FOCUS}`} data-testid="board-crumb">{step.label}</Link>
            ) : (
              <span className="truncate font-medium text-foreground" aria-current="page" data-testid="board-crumb-here">{step.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface TrackRow {
  id: string;
  game: string;
  name: string;
  lengthM: number | null;
  layoutId: string | null;
  /** Laps on the public board (from the catalog); null when the track has none there. */
  publicLaps: number | null;
  /** Your best valid lap there; null when you did not drive it. */
  myBestMs: number | null;
  lastDrivenAt: string | null;
}

/**
 * The first step: a tab for each game (the ones you drive, most recent first, then the others with public laps) and the tracks of the chosen
 * game, the ones you drove first. Nothing is chosen for the person: the game tab only starts on the one they drove last.
 */
export function GameBoards({ game, scope, onGame, emptyNode }: { game: string | null; scope: Scope; onGame: (game: string) => void; emptyNode: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const games = useGames();
  const { distanceUnit } = useSettings();
  const lang = i18n.resolvedLanguage || 'en';
  const own = useTracks();
  useReadAllPages(own);
  const catalog = useWholeCatalog({ kind: 'track' });
  const [search, setSearch] = useState('');

  const gameIds = useMemo(() => {
    const driven = [...own.items].sort((p, q) => Date.parse(q.lastDrivenAt) - Date.parse(p.lastDrivenAt)).map((entry) => entry.game);
    const others = catalog.items.map((entry) => entry.game).sort((p, q) => games.name(p).localeCompare(games.name(q)));
    return [...new Set([...driven, ...others])];
  }, [own.items, catalog.items, games]);
  const chosen = game && gameIds.includes(game) ? game : gameIds[0] ?? null;
  useEffect(() => setSearch(''), [chosen]);

  const rows = useMemo<TrackRow[]>(() => {
    if (!chosen) return [];
    const byId = new Map<string, TrackRow>();
    for (const entry of own.items.filter((item) => item.game === chosen)) {
      byId.set(entry.id, { id: entry.id, game: entry.game, name: entry.name, lengthM: entry.lengthM, layoutId: entry.hasLayout === false ? null : entry.layoutId ?? null, publicLaps: null, myBestMs: entry.bestLapMs, lastDrivenAt: entry.lastDrivenAt });
    }
    for (const entry of catalog.items.filter((item) => item.game === chosen)) {
      const mine = byId.get(entry.id);
      byId.set(entry.id, mine
        ? { ...mine, publicLaps: entry.lapCount, lengthM: mine.lengthM ?? entry.lengthM ?? null }
        : { id: entry.id, game: entry.game, name: entry.name, lengthM: entry.lengthM ?? null, layoutId: null, publicLaps: entry.lapCount, myBestMs: null, lastDrivenAt: null });
    }
    const driven = [...byId.values()].filter((row) => row.lastDrivenAt).sort((p, q) => Date.parse(q.lastDrivenAt!) - Date.parse(p.lastDrivenAt!));
    const others = [...byId.values()].filter((row) => !row.lastDrivenAt).sort((p, q) => p.name.localeCompare(q.name));
    return [...driven, ...others];
  }, [chosen, own.items, catalog.items]);
  const shown = search ? rows.filter((row) => fold(row.name).includes(fold(search))) : rows;

  const loading = own.isPending || catalog.isPending;
  // Nothing driven and no public laps anywhere: the invite. A read that failed is not "nothing": the error below says so.
  if (!loading && !own.isError && !catalog.isError && gameIds.length === 0) return <>{emptyNode}</>;
  const scoped = scope === 'friends' ? ('friends' as const) : undefined;

  return (
    <div className="space-y-4" data-testid="board-games">
      <QueryGate query={own} empty={false} skeleton={<Skeleton className="h-48 w-full rounded-xl" />}>
        {gameIds.length > 1 && chosen && (
          <Tabs value={chosen} onValueChange={onGame}>
            <TabsList aria-label={t('social.leaderboard.game', 'Game')} className="h-auto flex-wrap justify-start" data-testid="board-game-tabs">
              {gameIds.map((id) => <TabsTrigger key={id} value={id} data-testid={`board-game-${id}`}>{games.name(id)}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        )}
        {gameIds.length === 1 && chosen && <GameBadge game={chosen} />}

        <section className="space-y-2" aria-labelledby="board-tracks-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="board-tracks-title" className="text-sm font-semibold">{t('social.leaderboard.tracksTitle', 'Tracks')}</h3>
            {rows.length >= SEARCH_FROM && (
              <label className="relative w-full sm:w-64">
                <span className="sr-only">{t('social.leaderboard.searchTrack', 'Search a track')}</span>
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('social.leaderboard.searchTrack', 'Search a track')} className="h-9 pl-8" data-testid="board-track-search" />
              </label>
            )}
          </div>
          {/* The public tracks could not be read: say so, and still list yours. */}
          {catalog.isError && <ErrorPanel error={catalog.error} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />}
          {catalog.isPending && rows.length === 0 ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : catalog.isError && rows.length === 0 ? null : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="board-tracks-none">{t('social.leaderboard.noMatch', 'Nothing matches what you typed.')}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="board-tracks">
              {shown.map((row) => (
                <li key={row.id}>
                  <Link to={leaderboardPath({ game: row.game, track: row.id, scope: scoped })} className={`block h-full ${FOCUS} rounded-xl`} data-testid="board-track" data-track-id={row.id}>
                    <Card className="flex h-full items-center gap-3 bg-card p-3 transition-colors hover:bg-muted/40">
                      <TrackThumb layoutId={row.layoutId} name={row.name} className="h-14 w-14" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="truncate font-medium">{row.name}</p>
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          {typeof row.lengthM === 'number' && row.lengthM > 0 && <span>{formatDistance(row.lengthM, distanceUnit as DistanceUnit, lang)}</span>}
                          <span data-testid="board-track-public">{row.publicLaps
                            ? t('social.leaderboard.publicLaps', 'Public laps: {{count}}', { count: row.publicLaps })
                            : t('social.leaderboard.noPublicLaps', 'No public laps yet')}</span>
                        </p>
                        {row.myBestMs !== null && (
                          <p className="text-xs" data-testid="board-track-mine">
                            <span className="text-muted-foreground">{t('social.leaderboard.yourBest', 'Your best')} </span>
                            <span className="font-mono tabular-nums">{formatLapTime(row.myBestMs)}</span>
                          </p>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </QueryGate>
    </div>
  );
}

interface CarRow { id: string; name: string; carClass: string | null; publicLaps: number | null; myBestMs: number | null }

/**
 * The second step: one track, and the cars that have a board there: the ones you drove on it (fastest first) and the others with public laps.
 * Each opens its board.
 */
export function TrackBoards({ game, trackId, scope }: { game: string | null; trackId: string; scope: Scope }) {
  const { t, i18n } = useTranslation();
  const { distanceUnit } = useSettings();
  const lang = i18n.resolvedLanguage || 'en';
  // Your own numbers on the track (any catalog track answers; one you never drove has no cars), and the track's name from the catalog as well,
  // so the list still stands when the detail cannot be read.
  const detail = useTrack(trackId);
  const tracks = useWholeCatalog({ kind: 'track' });
  const listed = tracks.items.find((entry) => entry.id === trackId);
  const info = detail.data?.track ?? (listed ? { id: listed.id, game: listed.game, name: listed.name, lengthM: listed.lengthM ?? null, hasLayout: false, layoutId: null } : undefined);
  const theGame = info?.game ?? game;
  const catalog = useWholeCatalog({ kind: 'car', game: theGame, track: trackId }, !!theGame);
  const scoped = scope === 'friends' ? ('friends' as const) : undefined;

  const rows = useMemo<CarRow[]>(() => {
    const byId = new Map<string, CarRow>();
    for (const entry of detail.data?.bestPerCar ?? []) {
      if (entry.bestMs === null) continue;
      byId.set(entry.car.id, { id: entry.car.id, name: entry.car.name, carClass: entry.car.class, publicLaps: null, myBestMs: entry.bestMs });
    }
    for (const entry of catalog.items) {
      const mine = byId.get(entry.id);
      byId.set(entry.id, mine ? { ...mine, publicLaps: entry.lapCount, carClass: mine.carClass ?? entry.class ?? null } : { id: entry.id, name: entry.name, carClass: entry.class ?? null, publicLaps: entry.lapCount, myBestMs: null });
    }
    const mine = [...byId.values()].filter((row) => row.myBestMs !== null).sort((p, q) => p.myBestMs! - q.myBestMs!);
    const others = [...byId.values()].filter((row) => row.myBestMs === null).sort((p, q) => p.name.localeCompare(q.name));
    return [...mine, ...others];
  }, [detail.data, catalog.items]);

  return (
    <div className="space-y-4" data-testid="board-track-cars">
      <BoardCrumbs scope={scope} game={theGame} track={{ id: trackId, name: info?.name ?? '' }} />
      <QueryGate query={catalog} empty={false} skeleton={<Skeleton className="h-48 w-full rounded-xl" />}>
        <Card className="flex items-center gap-3 bg-card p-4">
          <TrackThumb layoutId={info?.hasLayout === false ? null : info?.layoutId} name={info?.name ?? ''} className="h-16 w-16" />
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="truncate text-lg font-bold" data-testid="board-track-title">{info?.name || '–'}</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {typeof info?.lengthM === 'number' && info.lengthM > 0 && <span>{formatDistance(info.lengthM, distanceUnit as DistanceUnit, lang)}</span>}
              {theGame && <GameBadge game={theGame} />}
              <Link to={trackPagePath(trackId)} className={`underline ${FOCUS}`} data-testid="board-track-page">{t('social.leaderboard.trackPage', 'Track page')}</Link>
            </div>
          </div>
        </Card>

        <section className="space-y-2" aria-labelledby="board-cars-title">
          <h3 id="board-cars-title" className="text-sm font-semibold">{t('social.leaderboard.carsTitle', 'Choose a car to see its board')}</h3>
          {detail.isPending && rows.length === 0 ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="board-cars-none">
              {t('social.leaderboard.noCars', 'No boards on this track yet. They appear as soon as someone drives a valid lap here.')}
            </p>
          ) : (
            <Card className="overflow-hidden bg-card">
              <ul className="divide-y divide-border" data-testid="board-cars">
                {rows.map((row) => (
                  <li key={row.id}>
                    <Link to={leaderboardPath({ game: theGame ?? undefined, track: trackId, car: row.id, scope: scoped })} className={`flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 ${FOCUS}`} data-testid="board-car" data-car-id={row.id}>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <SimCarIdentity name={row.name} className="min-w-0 text-sm font-medium" />
                          {row.carClass && <Badge variant="secondary" className="text-2xs">{row.carClass}</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground" data-testid="board-car-public">{row.publicLaps
                          ? t('social.leaderboard.publicLaps', 'Public laps: {{count}}', { count: row.publicLaps })
                          : t('social.leaderboard.onlyYours', 'Only your laps so far')}</p>
                      </div>
                      {row.myBestMs !== null && (
                        <span className="shrink-0 text-right" data-testid="board-car-mine">
                          <span className="block font-mono text-sm tabular-nums">{formatLapTime(row.myBestMs)}</span>
                          <span className="block text-2xs text-muted-foreground">{t('social.leaderboard.yourBest', 'Your best')}</span>
                        </span>
                      )}
                      <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground')} aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </QueryGate>
    </div>
  );
}
