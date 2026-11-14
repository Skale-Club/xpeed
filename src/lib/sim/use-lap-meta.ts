import { useQuery } from '@tanstack/react-query';
import { STALE, lapPath, useUserId, v1Get, v1Keys, type V1Lap } from '@/lib/sim/v1-client';

/**
 * One lap's metadata (`GET /laps/<id>`): its track and car ids and its session, which the lap file does not carry. Compare names laps by id only, so this is
 * how it finds what else was driven on the same track and car. Nothing is read without an id.
 */
export function useLapMeta(lapId: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: [...v1Keys.account(userId), 'lap', lapId],
    queryFn: () => v1Get<V1Lap>(lapPath(lapId ?? '')),
    enabled: !!userId && !!lapId,
    staleTime: STALE.detail,
  });
}
