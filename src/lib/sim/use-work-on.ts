import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import type { SessionInsights } from '@/lib/sim/insights';
import { sessionFindings, type SessionFinding } from '@/lib/sim/insight-text';
import { studyClient } from '@/lib/sim/lap-study-client';
import { openLap } from '@/lib/sim/library';
import { isPitLap, isTimed } from '@/lib/sim/session-stats';
import { STALE, v1Get, v1Keys, type V1Lap, type V1Session } from '@/lib/sim/v1-client';

/** A session needs this many valid laps (pit laps left out) before it says anything about consistency. */
export const MIN_LAPS = 3;
/** At most this many laps of the session are downloaded for the analysis: the fastest ones. */
export const MAX_LAPS = 12;
/** How many of the latest sessions are looked at, newest first, to find one with enough laps. */
export const MAX_SESSIONS = 5;

export interface WorkOn {
  session: V1Session;
  /** The laps of the session the analysis used. */
  lapsUsed: number;
  /** The two things worth working on (fewer when the data does not say more). Empty: nothing worth saying. */
  findings: SessionFinding[];
  insights: SessionInsights;
}

/** The laps of a session that count for the analysis: valid, timed, not through the pits. */
export const usableLaps = (laps: readonly V1Lap[]): V1Lap[] => laps.filter((lap) => isTimed(lap) && !isPitLap(lap));

/** Downloads in small groups, so a dozen laps do not all ask at once. */
async function inGroups<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

/**
 * "What to work on": the most recent of the latest sessions with at least 3 valid laps is read (its lap list, then the files of its
 * fastest laps, only that one session) and analysed off the page's thread. The answer is null when no session qualifies. It starts
 * only when `enabled`, so the page it belongs to is already on screen, and it is never retried by itself: when it cannot be worked
 * out the card is simply not shown.
 */
export function useWorkOn(latest: readonly V1Session[], enabled: boolean) {
  const userId = useAuth().user?.id ?? null;
  const client = useQueryClient();
  const candidates = latest.filter((session) => session.lapCount >= MIN_LAPS).slice(0, MAX_SESSIONS);
  const signature = candidates.map((session) => `${session.id}:${session.lapCount}:${session.bestLapMs ?? ''}`).join('|');
  return useQuery({
    queryKey: [...v1Keys.account(userId), 'work-on', signature],
    enabled: enabled && !!userId && candidates.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<WorkOn | null> => {
      for (const session of candidates) {
        const detail = await client.fetchQuery({
          queryKey: v1Keys.session(userId, session.id),
          queryFn: () => v1Get<{ session: V1Session; laps: V1Lap[] }>(`/sessions/${encodeURIComponent(session.id)}`),
          staleTime: STALE.detail,
        });
        const usable = usableLaps(detail.laps);
        if (usable.length < MIN_LAPS) continue;
        const chosen = [...usable].sort((p, q) => p.timeMs - q.timeMs).slice(0, MAX_LAPS);
        const files = await inGroups(chosen, 4, (lap) => openLap(userId!, lap.id, { sessionId: session.id }));
        const insights = await studyClient().session(files);
        return { session, lapsUsed: files.length, findings: sessionFindings(insights), insights };
      }
      return null;
    },
  });
}
