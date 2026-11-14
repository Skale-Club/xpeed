import { useQuery } from '@tanstack/react-query';
import { STALE, useUserId, v1Get, v1Keys, type V1Lap, type V1Session } from '@/lib/sim/v1-client';

/**
 * The laps of one session, for the sparkline and the lap tally of a row of the list. The same call and the same cache entry as the session page
 * (so opening the session is instant), but read once and only when asked: no refresh every minute for every row of a long list.
 */
export function useSessionPreview(id: string, enabled: boolean) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.session(userId, id),
    queryFn: () => v1Get<{ session: V1Session; laps: V1Lap[] }>(`/sessions/${encodeURIComponent(id)}`),
    enabled: !!userId && enabled,
    staleTime: STALE.detail,
  });
}
