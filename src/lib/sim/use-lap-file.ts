import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { openLap } from '@/lib/sim/library';

export const lapFileKey = (userId: string | null, lapId: string | null) => ['sim-lap-file', userId, lapId] as const;

/**
 * One lap's samples by the server's lap id: read from the device's cache, or downloaded once (see `openLap`). `isPending` while
 * the file comes down; `isError` (with the V1Error or LapReadError) when it cannot be had, and `refetch` tries again.
 * Not retried by itself: the screen shows the failure and a retry button.
 */
export function useLapFile(lapId: string | null) {
  const userId = useAuth().user?.id ?? null;
  return useQuery({
    queryKey: lapFileKey(userId, lapId),
    queryFn: () => openLap(userId!, lapId!),
    enabled: !!userId && !!lapId,
    staleTime: Infinity,
    // The samples of a lap are big: they are let go a few minutes after the screen stops using them.
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
