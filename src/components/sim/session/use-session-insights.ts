import { useQuery } from '@tanstack/react-query';
import type { SessionFinding } from '@/lib/sim/insight-text';
import { STALE, isSignedOut, useUserId, v1Get, v1Keys, type V1InsightFinding, type V1SessionInsights } from '@/lib/sim/v1-client';

const KINDS = new Set(['sectorGain', 'sectorSpread', 'consistency']);

/** Whether an answer is what `GET /sessions/<id>/insights` says (an older server answers something else, or nothing). */
const isInsights = (value: unknown): value is V1SessionInsights => {
  const answer = value as V1SessionInsights | null;
  return !!answer && answer.source === 'metadata' && Array.isArray(answer.findings) && answer.findings.every((finding) => !!finding && KINDS.has(finding.kind));
};

export const findingOf = (finding: V1InsightFinding): SessionFinding =>
  finding.kind === 'sectorGain' ? { kind: 'sectorGain', sector: finding.sector, seconds: finding.gainMs / 1000 }
    : finding.kind === 'sectorSpread' ? { kind: 'sectorSpread', sector: finding.sector, seconds: finding.stdDevMs / 1000 }
      : { kind: 'consistency', seconds: finding.stdDevMs / 1000, laps: finding.laps };

/**
 * What the server says of the session from the stored lap metadata (no lap file): up to two findings. Null when it cannot say (an older server, an outage, an
 * answer that is not one); only a signed-out answer is an error, and the page already says that.
 */
export function useSessionInsights(sessionId: string | null, version: string) {
  const userId = useUserId();
  return useQuery({
    queryKey: [...v1Keys.session(userId, sessionId), 'insights', version],
    queryFn: async () => {
      try {
        const answer = await v1Get<V1SessionInsights>(`/sessions/${encodeURIComponent(sessionId ?? '')}/insights`);
        return isInsights(answer) ? answer : null;
      } catch (error) {
        if (isSignedOut(error)) throw error;
        return null;
      }
    },
    enabled: !!userId && !!sessionId,
    staleTime: STALE.detail,
  });
}
