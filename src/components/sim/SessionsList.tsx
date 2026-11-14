import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/contexts/SettingsContext';
import { useGames } from '@/lib/sim/games';
import {
  activeFilterCount, applyClientFilters, dayKey, dayRelation, groupByDay, needsMorePages, pbIndex, pbKey, readFilters, singlePair, summarizeSessions, withFilter,
  type FilterKey,
} from '@/lib/sim/sessions-view';
import { useCars, useOverview, usePbs, useSessions, useTracks } from '@/lib/sim/v1-client';
import { useReadAllPages } from './use-read-all-pages';
import { CompanionInvite, ListSkeleton, LoadMore, QueryGate } from './SimStates';
import { SessionFilterBar } from './sessions/Filters';
import { SessionRow } from './sessions/SessionRow';
import { SessionsSummaryStrip } from './sessions/SummaryStrip';
import { useScrollRestore } from './sessions/use-scroll-restore';
import { useDashFormat } from './overview/use-format';

/** How many pages are read by themselves to complete a filter the server cannot apply (50 sessions each). */
const MAX_FILTER_PAGES = 10;

/** The heading of a day of the list: "Today", "Yesterday" or the date with its weekday, and how many sessions and laps the day holds. */
function DayHeading({ day, today, sessions, laps }: { day: string; today: string; sessions: number; laps: number }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const relation = dayRelation(day, today);
  const date = (() => {
    const at = Date.parse(`${day}T12:00:00.000Z`);
    try {
      return new Intl.DateTimeFormat(format.lang, { weekday: 'long', day: 'numeric', month: 'long', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC' }).format(at);
    } catch {
      return day;
    }
  })();
  return (
    <h3
      className="sticky top-14 z-20 -mx-1 flex items-baseline justify-between gap-3 bg-background/95 px-1 py-1.5 text-sm backdrop-blur"
      data-testid="day-heading"
      data-day={day}
    >
      <span className="font-semibold first-letter:capitalize">
        {relation === 'today' ? t('sessionsDash.list.today', 'Today') : relation === 'yesterday' ? t('sessionsDash.list.yesterday', 'Yesterday') : date}
        {relation !== 'other' && <span className="ml-2 text-xs font-normal text-muted-foreground first-letter:normal-case">{date}</span>}
      </span>
      <span className="text-xs font-normal text-muted-foreground">
        {t('sessionsDash.list.daySessions', { count: sessions, defaultValue_one: '{{count}} session', defaultValue_other: '{{count}} sessions' })}
        {' · '}
        {t('sessionsDash.list.dayLaps', { count: laps, defaultValue_one: '{{count}} lap', defaultValue_other: '{{count}} laps' })}
      </span>
    </h3>
  );
}

/**
 * Virtual > Sessions: the sessions on the account (Xpeed Companion groups the laps by what the game says), newest first, a page at a time. The header filters
 * by game, track and car (asked of the server) and by kind, period and "valid laps only" (applied to what was read, reading further pages by itself until the
 * answer is whole); every filter lives in the address. A strip sums up the filtered set, and the sessions come as cards grouped under their day. Nothing here
 * opens a lap file; the laps of a session are read once, when its card is about to be seen, for its sparkline and its valid-lap count.
 */
export function SessionsList() {
  const { t } = useTranslation();
  const games = useGames();
  const { timezone } = useSettings();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const { game, track, car } = filters;

  const overview = useOverview();
  const tracks = useTracks(game ? { game } : {});
  const cars = useCars(game ? { game } : {});
  useReadAllPages(tracks);
  useReadAllPages(cars);
  const sessions = useSessions({ game: game || undefined, track: track || undefined, car: car || undefined });
  const pbs = usePbs({ game: game || undefined }, { enabled: sessions.items.length > 0 });
  useReadAllPages(pbs);
  const pbsByPair = useMemo(() => pbIndex(pbs.items), [pbs.items]);
  const pbsReady = pbs.isSuccess && !pbs.hasNextPage;

  const change = (key: FilterKey, value: string | boolean) => setParams(withFilter(params, key, value), { replace: true });
  const clear = () => setParams(new URLSearchParams(), { replace: true });

  // The server cannot filter by kind, period or valid laps: the pages are read (newest first) until the answer is whole.
  const pagesRead = sessions.data?.pages.length ?? 0;
  const reading = needsMorePages(filters, sessions.items, !!sessions.hasNextPage, Date.now()) && pagesRead < MAX_FILTER_PAGES;
  useEffect(() => {
    if (reading && !sessions.isFetching) void sessions.fetchNextPage();
  }, [reading, sessions]);

  const shown = useMemo(() => applyClientFilters(sessions.items, filters, Date.now()), [sessions.items, filters]);
  const summary = useMemo(() => summarizeSessions(shown), [shown]);
  const groups = useMemo(() => groupByDay(shown, timezone), [shown, timezone]);
  const today = dayKey(Date.now(), timezone);
  useScrollRestore(params.toString(), sessions.items.length > 0);

  const named = (item: { name: string; game: string }) => (game ? item.name : `${item.name} · ${games.name(item.game)}`);
  const filtered = activeFilterCount(filters) > 0;
  const noMatch = (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-4" data-testid="sessions-no-match">
      <p className="text-sm text-muted-foreground">{t('modes.sessions.noMatch', 'No session matches these filters.')}</p>
      <Button size="sm" variant="outline" onClick={clear}>
        {t('modes.sessions.clearFilters', 'Clear the filters')}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="sessions">
      {/* An account with no sessions has nothing to filter: just the invitation. */}
      {(sessions.items.length > 0 || sessions.isPending || sessions.isError || filtered) && (
        <SessionFilterBar
          filters={filters}
          onChange={change}
          onClear={clear}
          gameOptions={(overview.data?.lapsPerGame ?? []).map((entry) => ({ value: entry.game, label: games.name(entry.game) }))}
          trackOptions={tracks.items.map((item) => ({ value: item.id, label: named(item) }))}
          carOptions={cars.items.map((item) => ({ value: item.id, label: named(item) }))}
        />
      )}

      <QueryGate query={sessions} empty={sessions.items.length === 0} emptyNode={filtered ? noMatch : <CompanionInvite testId="sessions-empty" />} skeleton={<ListSkeleton rows={4} />}>
        {shown.length === 0 ? (
          reading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="sessions-reading">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('sessionsDash.list.reading', 'Looking through your sessions…')}
            </p>
          ) : (
            noMatch
          )
        ) : (
          <div className="space-y-4">
            <SessionsSummaryStrip summary={summary} showBest={singlePair(filters)} more={!!sessions.hasNextPage} />
            <div className="space-y-3" data-testid="session-groups">
              {groups.map((group) => (
                <section key={group.day} aria-label={group.day} className="space-y-2">
                  <DayHeading day={group.day} today={today} sessions={group.sessions.length} laps={group.laps} />
                  <ul className="space-y-2.5">
                    {group.sessions.map((session) => (
                      <SessionRow key={session.id} session={session} pb={pbsByPair.get(pbKey(session.track.id, session.car.id))} pbsReady={pbsReady} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {reading && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="sessions-reading">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('sessionsDash.list.reading', 'Looking through your sessions…')}
              </p>
            )}
            <LoadMore hasNextPage={!!sessions.hasNextPage && !reading} isFetchingNextPage={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()} />
          </div>
        )}
      </QueryGate>
    </div>
  );
}
