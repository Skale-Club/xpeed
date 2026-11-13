import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useGames } from '@/lib/sim/games';
import { formatLapTime } from '@/lib/sim/analysis';
import { sessionPath } from '@/lib/sim/routes';
import { useCars, useOverview, useSessions, useTracks, type V1Session } from '@/lib/sim/v1-client';
import { FilterSelect } from './FilterSelect';
import { useReadAllPages } from './use-read-all-pages';
import { GameBadge, KindBadge } from './session-bits';
import { useConditions, useOrigin } from './use-session-text';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

/** One session, as a card that opens its page. Nothing here needs a lap file. */
export function SessionCard({ session }: { session: V1Session }) {
  const { t } = useTranslation();
  const when = useWhen();
  const conditions = useConditions();
  const origin = useOrigin();
  const weather = conditions(session);
  return (
    <Link to={sessionPath(session.id)} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="session-link">
      <Card className="bg-card border-border transition-colors hover:bg-muted/30" data-testid="session">
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{session.track.name}</h3>
              <SimCarIdentity name={session.car.name} className="text-sm text-muted-foreground" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={session.kind} />
              <GameBadge game={session.game} />
              <ChevronRight className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {when(Date.parse(session.startedAt))}
            {weather ? ` · ${weather}` : ''}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
            <span>{t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.lapCount })}</span>
            <span data-testid="session-best">
              <span className="text-xs text-muted-foreground">{t('modes.sessions.bestLabel', 'Best valid lap')}: </span>
              <span className="font-mono tabular-nums">{session.bestLapMs !== null ? formatLapTime(session.bestLapMs) : '–'}</span>
            </span>
            <span className="text-xs text-muted-foreground" data-testid="session-origin">{origin(session.origin)}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Virtual > Sessions: the sessions on the account (Xpeed Companion groups the laps by what the game says), newest first, a page
 * at a time, filtered by game, track and car. The list never opens a lap file.
 */
export function SessionsList() {
  const { t } = useTranslation();
  const games = useGames();
  const [params, setParams] = useSearchParams();
  const game = params.get('game') ?? '';
  const track = params.get('track') ?? '';
  const car = params.get('car') ?? '';
  const filtered = !!(game || track || car);

  const overview = useOverview();
  const tracks = useTracks(game ? { game } : {});
  const cars = useCars(game ? { game } : {});
  useReadAllPages(tracks);
  useReadAllPages(cars);
  const sessions = useSessions({ game: game || undefined, track: track || undefined, car: car || undefined });

  const setFilter = (key: 'game' | 'track' | 'car', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // A track or a car belongs to one game: another game starts those over.
    if (key === 'game') {
      next.delete('track');
      next.delete('car');
    }
    setParams(next, { replace: true });
  };

  const named = (item: { name: string; game: string }) => (game ? item.name : `${item.name} · ${games.name(item.game)}`);

  return (
    <div className="space-y-4" data-testid="sessions">
      <p className="text-sm text-muted-foreground">{t('modes.sessions.intro', 'Your sessions: the laps Xpeed Companion sent, grouped by car and track as the game ran them.')}</p>

      <div className="grid gap-3 sm:grid-cols-3" data-testid="session-filters">
        <FilterSelect
          label={t('modes.sessions.filterGame', 'Game')}
          allLabel={t('modes.sessions.all', 'All')}
          value={game}
          onChange={(value) => setFilter('game', value)}
          options={(overview.data?.lapsPerGame ?? []).map((entry) => ({ value: entry.game, label: games.name(entry.game) }))}
          testId="filter-game"
        />
        <FilterSelect
          label={t('modes.sessions.filterTrack', 'Track')}
          allLabel={t('modes.sessions.all', 'All')}
          value={track}
          onChange={(value) => setFilter('track', value)}
          options={tracks.items.map((item) => ({ value: item.id, label: named(item) }))}
          testId="filter-track"
        />
        <FilterSelect
          label={t('modes.sessions.filterCar', 'Car')}
          allLabel={t('modes.sessions.all', 'All')}
          value={car}
          onChange={(value) => setFilter('car', value)}
          options={cars.items.map((item) => ({ value: item.id, label: named(item) }))}
          testId="filter-car"
        />
      </div>

      <QueryGate
        query={sessions}
        empty={sessions.items.length === 0}
        emptyNode={
          filtered ? (
            <div className="space-y-2 rounded-lg border border-dashed border-border p-4" data-testid="sessions-no-match">
              <p className="text-sm text-muted-foreground">{t('modes.sessions.noMatch', 'No session matches these filters.')}</p>
              <Button size="sm" variant="outline" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                {t('modes.sessions.clearFilters', 'Clear the filters')}
              </Button>
            </div>
          ) : (
            <CompanionInvite testId="sessions-empty" />
          )
        }
      >
        <div className="space-y-3">
          {sessions.items.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
        <LoadMore hasNextPage={!!sessions.hasNextPage} isFetchingNextPage={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()} />
      </QueryGate>
    </div>
  );
}
