import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import type { SessionInsights } from '@/lib/sim/insights';
import { sessionFindings, type SessionFinding } from '@/lib/sim/insight-text';
import { studyClient } from '@/lib/sim/lap-study-client';
import { openLap } from '@/lib/sim/library';
import { isPitLap, isTimed } from '@/lib/sim/session-stats';
import { STALE, isSignedOut, v1Get, v1Keys, type V1InsightFinding, type V1Lap, type V1Session, type V1SessionInsights } from '@/lib/sim/v1-client';

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
  /** The corner analysis the findings came from; null when the server worked them out from the lap metadata (no lap file was read). */
  insights: SessionInsights | null;
}

/** The laps of a session that count for the analysis: valid, timed, not through the pits. */
export const usableLaps = (laps: readonly V1Lap[]): V1Lap[] => laps.filter((lap) => isTimed(lap) && !isPitLap(lap));

/** Downloads in small groups, so a dozen laps do not all ask at once. */
async function inGroups<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

const KINDS = new Set(['sectorGain', 'sectorSpread', 'consistency']);
const isInsights = (value: unknown): value is V1SessionInsights => {
  const answer = value as V1SessionInsights | null;
  return !!answer && answer.source === 'metadata' && typeof answer.lapsUsed === 'number' && Array.isArray(answer.findings)
    && answer.findings.every((finding) => !!finding && KINDS.has(finding.kind));
};

/** What the server says of one session from its stored lap metadata, or null when it cannot (an older server, an outage, an answer that is not one). */
async function serverInsights(client: QueryClient, userId: string | null, session: V1Session): Promise<V1SessionInsights | null> {
  try {
    const answer = await client.fetchQuery({
      queryKey: [...v1Keys.session(userId, session.id), 'insights', session.lapCount, session.bestLapMs],
      queryFn: () => v1Get<V1SessionInsights>(`/sessions/${encodeURIComponent(session.id)}/insights`),
      staleTime: STALE.detail,
    });
    return isInsights(answer) ? answer : null;
  } catch (error) {
    if (isSignedOut(error)) throw error;
    return null;
  }
}

const findingOf = (finding: V1InsightFinding): SessionFinding =>
  finding.kind === 'sectorGain' ? { kind: 'sectorGain', sector: finding.sector, seconds: finding.gainMs / 1000 }
    : finding.kind === 'sectorSpread' ? { kind: 'sectorSpread', sector: finding.sector, seconds: finding.stdDevMs / 1000 }
      : { kind: 'consistency', seconds: finding.stdDevMs / 1000, laps: finding.laps };

/**
 * "What to work on": the most recent of the latest sessions with at least 3 valid laps is read (its lap list, then the files of its
 * fastest laps, only that one session) and analysed off the page's thread. The answer is null when no session qualifies. It starts
 * only when `enabled`, so the page it belongs to is already on screen, and it is never retried by itself: when it cannot be worked
 * out the card is simply not shown.
 *
 * The server is asked first (`GET /sessions/<id>/insights`: best sectors, spread and consistency from the stored lap metadata, no
 * file): when it answers with findings those are the card, and no lap file is downloaded. When it cannot (an older server, an
 * outage) or has nothing to say, the files of the fastest laps are read and the corners analysed here, as before.
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
        const fast = await serverInsights(client, userId, session);
        if (fast) {
          if (fast.lapsUsed < MIN_LAPS) continue;
          if (fast.findings.length > 0) return { session, lapsUsed: fast.lapsUsed, findings: fast.findings.slice(0, 2).map(findingOf), insights: null };
        }
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
