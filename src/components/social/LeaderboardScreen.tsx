import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Info, LineChart, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadMore, QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useGames } from '@/lib/sim/games';
import { leaderboardPath, useLeaderboard, useLeaderboardMe, type BoardQuery, type LeaderboardEntry, type Scope } from '@/lib/sim/social-client';
import { useCars, useOverview, useTracks } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { ReportButton } from './ReportDialog';
import { DriverName, PlainSelect } from './social-bits';
import { ordinal } from './social-utils';

const SCOPES: readonly Scope[] = ['public', 'friends'];

/** The gap to the leader in seconds, as the rest of the app writes it (`+0.123`). */
const gapText = (gapMs: number) => (gapMs <= 0 ? '' : formatGap(gapMs / 1000));

/** One row of the board; the person's own row is highlighted. Compare is only offered for one's own lap; Report for everybody else's. */
function BoardRow({ entry }: { entry: LeaderboardEntry }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  return (
    <tr
      className={cn('border-t border-border', entry.isMe && 'bg-primary/10 font-medium')}
      aria-current={entry.isMe ? 'true' : undefined}
      data-testid="board-row"
      data-rank={entry.rank}
      data-me={entry.isMe ? 'true' : 'false'}
    >
      <td className="w-10 py-2 pl-2 pr-2 text-right font-mono tabular-nums" data-testid="board-rank">{entry.rank}</td>
      <td className="min-w-0 max-w-[10rem] py-2 pr-3 sm:max-w-none">
        <div className="flex items-center gap-2">
          <DriverName handle={entry.handle} displayName={entry.displayName} className="min-w-0 flex-wrap" />
          {entry.isMe && <Badge variant="secondary" data-testid="board-you">{t('social.leaderboard.you', 'You')}</Badge>}
        </div>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono tabular-nums" data-testid="board-time">{formatLapTime(entry.timeMs)}</td>
      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-xs tabular-nums text-muted-foreground" data-testid="board-gap">{gapText(entry.gapMs) || '–'}</td>
      <td className="hidden whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground sm:table-cell">{when(Date.parse(entry.achievedAt))}</td>
      <td className="whitespace-nowrap py-2 pr-2 text-right">
        {entry.isMe ? (
          <Button asChild size="sm" variant="outline" className="h-8 px-2">
            <Link to={compareUrl(entry.lapId)} aria-label={t('social.leaderboard.compareMine', 'Compare my lap')} data-testid="board-compare">
              <LineChart className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('social.leaderboard.compare', 'Compare')}</span>
            </Link>
          </Button>
        ) : (
          <ReportButton targets={[{ kind: 'lap', lapId: entry.lapId }, { kind: 'profile', handle: entry.handle }]} />
        )}
      </td>
    </tr>
  );
}

/** "You are 12th of 48", the gap to the leader and the drivers around you; or, when you are not on the board, why. */
function MyPlace({ query }: { query: BoardQuery }) {
  const { t, i18n } = useTranslation();
  const me = useLeaderboardMe(query);
  if (me.isPending) return <Skeleton className="h-16 w-full rounded-lg" />;
  if (me.isError || !me.data) return null;
  const { data } = me;
  if (!data.me) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" role="status" data-testid="board-not-listed">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p>
            {query.scope === 'public'
              ? t('social.leaderboard.notListedPublic', 'You are not listed because your profile is private, or your lap is not valid.')
              : t('social.leaderboard.notListedFriends', 'You are not listed here because you have no valid lap on this track and car.')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('social.leaderboard.notListedHelp', 'Only valid laps that pass the checks count. Public boards also need a public profile.')}{' '}
            <Link to="/virtual/profile" className="underline">{t('social.leaderboard.profileLink', 'Change who can see you')}</Link>
          </p>
        </div>
      </div>
    );
  }
  const place = ordinal(data.me.rank, i18n.resolvedLanguage || 'en');
  const around = [...data.neighbours.above, data.me, ...data.neighbours.below];
  return (
    <Card className="border-primary/40 bg-primary/5" data-testid="board-me">
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm font-semibold" data-testid="board-me-place">
            {t('social.leaderboard.place', 'You are {{place}} of {{total}}', { place, total: data.total })}
          </p>
          <p className="font-mono text-sm tabular-nums">
            {formatLapTime(data.me.timeMs)}
            {data.me.gapMs > 0 && <span className="ml-2 text-xs text-muted-foreground">{gapText(data.me.gapMs)}</span>}
          </p>
        </div>
        {around.length > 1 && (
          <ol className="grid max-w-md gap-1 text-xs" aria-label={t('social.leaderboard.around', 'The drivers around you')} data-testid="board-neighbours">
            {around.map((entry) => (
              <li key={entry.lapId} className={cn('flex items-center justify-between gap-2 rounded px-2 py-1', entry.isMe ? 'bg-primary/15 font-medium' : 'bg-background/60')}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="w-6 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{entry.rank}</span>
                  <DriverName handle={entry.handle} displayName={entry.displayName} link={!entry.isMe} className="min-w-0" testId="neighbour-name" />
                </span>
                <span className="shrink-0 font-mono tabular-nums">{formatLapTime(entry.timeMs)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Virtual > Leaderboards: the best valid lap of every driver on a track with a car, ranked, for everybody (Public) or for you and
 * your friends (Friends). The track and the car come from the ones you drove (the latest pair first) and live in the address so a
 * board can be linked to. Ties share a rank. Your row is highlighted and a strip says where you stand, or why you are not listed.
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

  // The pair you drove last, else the track and the car you drove last; an address that names them wins.
  const defaults = useMemo(() => {
    const track = tracks.items.find((entry) => entry.id === latest?.track.id) ?? tracks.items[0] ?? null;
    const car = cars.items.find((entry) => entry.id === latest?.car.id) ?? cars.items.find((entry) => entry.game === track?.game) ?? cars.items[0] ?? null;
    return { track: track?.id ?? null, car: car?.id ?? null };
  }, [tracks.items, cars.items, latest]);
  const track = urlTrack ?? defaults.track;
  const car = urlCar ?? defaults.car;
  const game = urlGame ?? tracks.items.find((entry) => entry.id === track)?.game ?? cars.items.find((entry) => entry.id === car)?.game ?? null;

  const query: BoardQuery = { track, car, scope, game };
  const board = useLeaderboard(query);

  const gameIds = useMemo(() => [...new Set([...tracks.items, ...cars.items].map((entry) => entry.game))], [tracks.items, cars.items]);
  const trackOptions = tracks.items.filter((entry) => !game || entry.game === game).map((entry) => ({ value: entry.id, label: entry.name }));
  const carOptions = cars.items.filter((entry) => !game || entry.game === game).map((entry) => ({ value: entry.id, label: entry.name }));

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
    const nextTrack = tracks.items.find((entry) => entry.game === next);
    const nextCar = cars.items.find((entry) => entry.game === next);
    write({ game: next, track: nextTrack?.id ?? null, car: nextCar?.id ?? null });
  };

  const loadingChoices = tracks.isPending || cars.isPending;
  const nothingDriven = !loadingChoices && !tracks.isError && !cars.isError && (tracks.items.length === 0 || cars.items.length === 0) && !(urlTrack && urlCar);
  const empty = board.entries.length === 0;

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
        skeleton={<Skeleton className="h-24 w-full rounded-lg" />}
      >
        <div className="grid gap-3 sm:grid-cols-3" data-testid="board-pickers">
          {gameIds.length > 1 && (
            <PlainSelect
              label={t('social.leaderboard.game', 'Game')}
              value={game ?? ''}
              onChange={pickGame}
              options={gameIds.map((id) => ({ value: id, label: games.name(id) }))}
              testId="board-game"
            />
          )}
          <PlainSelect
            label={t('social.leaderboard.track', 'Track')}
            value={track ?? ''}
            onChange={(value) => write({ track: value })}
            options={trackOptions}
            testId="board-track"
          />
          <PlainSelect
            label={t('social.leaderboard.car', 'Car')}
            value={car ?? ''}
            onChange={(value) => write({ car: value })}
            options={carOptions}
            testId="board-car"
          />
        </div>

        <Tabs value={scope} onValueChange={(value) => write({ scope: value === 'friends' ? 'friends' : 'public' })}>
          <TabsList aria-label={t('social.leaderboard.scope', 'Who to rank')}>
            {SCOPES.map((entry) => (
              <TabsTrigger key={entry} value={entry} data-testid={`scope-${entry}`}>
                {entry === 'public' ? t('social.leaderboard.public', 'Public') : t('social.leaderboard.friends', 'Friends')}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {track && car && (
          <>
            <MyPlace query={query} />
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
              skeleton={<Skeleton className="h-64 w-full rounded-lg" />}
            >
              <Card className="bg-card border-border">
                <CardContent className="space-y-3 p-0 pb-3 sm:p-4">
                  <div className="flex items-center gap-2 px-3 pt-3 text-sm font-semibold sm:px-0 sm:pt-0">
                    <Trophy className="h-4 w-4 text-primary" aria-hidden />
                    {board.meta?.track.name} · {board.meta?.car.name}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="board-table">
                      <caption className="sr-only">{t('social.leaderboard.caption', 'Best valid lap of each driver, fastest first')}</caption>
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th scope="col" className="py-1 pl-2 pr-2 text-right font-normal">{t('social.leaderboard.rank', 'Rank')}</th>
                          <th scope="col" className="py-1 pr-3 font-normal">{t('social.leaderboard.driver', 'Driver')}</th>
                          <th scope="col" className="py-1 pr-3 text-right font-normal">{t('social.leaderboard.time', 'Time')}</th>
                          <th scope="col" className="py-1 pr-3 text-right font-normal">{t('social.leaderboard.gap', 'Gap')}</th>
                          <th scope="col" className="hidden py-1 pr-3 font-normal sm:table-cell">{t('social.leaderboard.date', 'Date')}</th>
                          <th scope="col" className="py-1 pr-2 font-normal"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {board.entries.map((entry) => (
                          <BoardRow key={`${entry.rank}-${entry.lapId}`} entry={entry} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <LoadMore hasNextPage={!!board.hasNextPage} isFetchingNextPage={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()} />
                </CardContent>
              </Card>
            </QueryGate>
          </>
        )}
      </QueryGate>
    </div>
  );
}

function leaderboardParamsOf(value: { track: string | null; car: string | null; scope: Scope; game: string | null }): URLSearchParams {
  const url = new URL(`http://x${leaderboardPath({ track: value.track ?? undefined, car: value.car ?? undefined, game: value.game ?? undefined, scope: value.scope === 'friends' ? 'friends' : undefined })}`);
  return url.searchParams;
}
