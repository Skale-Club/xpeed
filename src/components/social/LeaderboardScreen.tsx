import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadMore, QueryGate } from '@/components/sim/SimStates';
import { useBoardConditions, useLeaderboard, useLeaderboardMe, type AidBoard, type BoardQuery, type Scope } from '@/lib/sim/social-client';
import { useTracks } from '@/lib/sim/v1-client';
import { BoardHero } from './BoardHero';
import { BoardPlace } from './BoardPlace';
import { BoardPodium } from './BoardPodium';
import { BoardTable } from './BoardTable';
import { AidChips } from './BoardAids';
import { TheoreticalBestLine, TyreChips } from './BoardConditions';
import { showAidChips, showTyreChips } from './social-utils';
import { BoardCrumbs, GameBoards, TrackBoards } from './board-browse';

const SCOPES: readonly Scope[] = ['public', 'friends'];

/**
 * Virtual > Leaderboards, found step by step: a game (its tracks), a track (its cars), then the board of that track and car. The address holds
 * the steps (`?game=&track=&car=&scope=`), so every step can be linked to, and nothing is chosen for the person: with no track in the address the
 * tracks are listed, with no car the cars of the track. The lists are made from the tracks and cars that have laps, so new ones show up by themselves.
 *
 * The board: the best valid lap of every driver on that track with that car, ranked, for everybody (Public) or for you and your friends (Friends).
 * A hero says which board it is, the top three stand on a podium once there are three, a card says where you stand, and the table ranks everyone.
 */
export function LeaderboardScreen() {
  const [params, setParams] = useSearchParams();
  const scope: Scope = params.get('scope') === 'friends' ? 'friends' : 'public';
  const track = params.get('track');
  const car = params.get('car');
  const game = params.get('game');
  // The tyre filter lives in the address like the rest, so a link to a filtered board opens filtered. An empty value is no filter.
  const tyre = params.get('tyre') || null;
  // The aid board too (`?aids=no_tc_abs` or `?aids=none`); anything else is the open board.
  const aidParam = params.get('aids');
  const aids: AidBoard = aidParam === 'no_tc_abs' || aidParam === 'none' ? aidParam : 'all';

  if (track && car) return <Board query={{ track, car, scope, game, tyre, aids }} onScope={(next) => {
    const out = new URLSearchParams(params);
    if (next === 'friends') out.set('scope', 'friends');
    else out.delete('scope');
    setParams(out, { replace: true });
  }} onTyre={(next) => {
    const out = new URLSearchParams(params);
    if (next) out.set('tyre', next);
    else out.delete('tyre');
    setParams(out, { replace: true });
  }} onAids={(next) => {
    const out = new URLSearchParams(params);
    if (next !== 'all') out.set('aids', next);
    else out.delete('aids');
    setParams(out, { replace: true });
  }} />;
  if (track) return <div data-testid="leaderboards"><TrackBoards game={game} trackId={track} scope={scope} /></div>;
  return (
    <div data-testid="leaderboards">
      <GameBoards
        game={game}
        scope={scope}
        onGame={(next) => {
          const out = new URLSearchParams({ game: next });
          if (scope === 'friends') out.set('scope', 'friends');
          setParams(out, { replace: true });
        }}
        emptyNode={<NothingDriven />}
      />
    </div>
  );
}

function NothingDriven() {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="board-nothing-driven">
      <p>{t('social.leaderboard.nothingDriven', 'Drive a lap first: the leaderboards show the tracks and cars you have driven.')}</p>
      <Button asChild size="sm" className="mt-3"><Link to="/virtual/companion">{t('modes.states.connect', 'Connect it to your account')}</Link></Button>
    </div>
  );
}

/** The board of one track and car. */
function Board({ query, onScope, onTyre, onAids }: { query: BoardQuery & { track: string; car: string }; onScope: (scope: Scope) => void; onTyre: (tyre: string | null) => void; onAids: (aids: AidBoard) => void }) {
  const { t } = useTranslation();
  // The table, the podium and "your position" all read the same query, so they follow the tyre together.
  const board = useLeaderboard(query);
  const me = useLeaderboardMe(query);
  const conditions = useBoardConditions(query);
  const tyre = query.tyre ?? null;
  const aids = query.aids ?? 'all';
  // The tracks you drove carry the circuit's layout, for the map in the hero.
  const tracks = useTracks();
  const driven = tracks.items.find((entry) => entry.id === query.track);
  const meta = board.meta;
  const game = meta?.game ?? query.game ?? driven?.game ?? null;
  const empty = board.entries.length === 0;

  const scopeTabs = (
    <Tabs value={query.scope} onValueChange={(value) => onScope(value === 'friends' ? 'friends' : 'public')}>
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
      <BoardCrumbs scope={query.scope} game={game} track={{ id: query.track, name: meta?.track.name ?? driven?.name ?? '' }} car={{ name: meta?.car.name ?? '' }} />
      <BoardHero
        trackId={query.track}
        trackName={meta?.track.name ?? driven?.name ?? ''}
        lengthM={meta?.track.lengthM ?? driven?.lengthM}
        layoutId={driven?.hasLayout === false ? null : driven?.layoutId}
        carName={meta?.car.name ?? ''}
        carClass={meta?.car.class}
        game={game}
        total={me.data?.total ?? null}
        leaderMs={board.entries[0]?.timeMs ?? null}
        myMs={me.data?.me?.timeMs ?? null}
        scopeTabs={scopeTabs}
      />

      {(showTyreChips(conditions.data, tyre) || showAidChips(conditions.data, aids)) && (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3" data-testid="board-conditions">
          <TyreChips conditions={conditions.data} tyre={tyre} onTyre={onTyre} />
          <AidChips conditions={conditions.data} aids={aids} onAids={onAids} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="order-2 min-w-0 space-y-4 lg:order-1 lg:col-span-8">
          <QueryGate
            query={board}
            empty={empty}
            emptyNode={
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="board-empty">
                {tyre
                  ? t('social.leaderboard.emptyTyre', 'No laps on this tyre for this track and car yet.')
                  : aids !== 'all'
                    ? t('social.leaderboard.emptyAids', 'No laps with these aids for this track and car yet.')
                    : query.scope === 'public'
                    ? t('social.leaderboard.emptyPublic', 'No public laps for this track and car yet.')
                    : t('social.leaderboard.emptyFriends', 'No laps from you or your friends for this track and car yet.')}
              </div>
            }
            skeleton={<Skeleton className="h-72 w-full rounded-xl" />}
          >
            <BoardPodium entries={board.entries} />
            <TheoreticalBestLine best={conditions.data?.theoreticalBest} />
            <BoardTable entries={board.entries} />
            <LoadMore hasNextPage={!!board.hasNextPage} isFetchingNextPage={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()} />
          </QueryGate>
        </div>
        <div className="order-1 min-w-0 space-y-4 lg:order-2 lg:col-span-4">
          <div className="lg:sticky lg:top-4">
            <BoardPlace me={me} scope={query.scope} entries={board.entries} tyre={tyre} aids={aids} />
          </div>
        </div>
      </div>
    </div>
  );
}
