// The admin side of first-party error tracking: the groups of reported errors (site and Xpeed Companion) and "mark resolved".
// Server: GET /api/sim/v1/admin/problems and POST /api/sim/v1/admin/problems/<id> (api/sim/_social.ts); admins only, anybody else gets 403.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE, useUserId, v1Get, v1Keys, v1Send } from '@/lib/sim/v1-client';

export type ProblemSource = 'site' | 'companion';
export type ProblemFilter = 'open' | 'resolved' | 'all';

export interface Problem {
  id: string;
  source: ProblemSource;
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  /** How many times it was reported, in all. */
  count: number;
  /** In the last 24 hours. */
  last24h: number;
  message: string;
  stack: string;
  /** The page, as a route pattern without a query string (site only). */
  route: string | null;
  version: string | null;
  /** Browser family (site) or Windows family (Companion). */
  agent: string | null;
  worker: string | null;
  /** How many different people it touched. Never who. */
  affectedUsers: number;
  resolvedAt: string | null;
  /** How many times it came back after being marked resolved. */
  reopenedCount: number;
}

const key = (userId: string | null, status: ProblemFilter) => [...v1Keys.account(userId), 'admin-problems', status] as const;

/** The problems, newest first. Only for an admin: the server answers 403 to anybody else. */
export function useProblems(status: ProblemFilter, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return useQuery({
    queryKey: key(userId, status),
    queryFn: async () => (await v1Get<{ problems: Problem[] }>('/admin/problems', { status, limit: 100 })).problems ?? [],
    enabled: !!userId && (options.enabled ?? true),
    staleTime: STALE.list,
    refetchOnWindowFocus: true,
  });
}

/** Marks a problem resolved, or open again. A resolved problem reopens by itself if it happens again later. */
export function useResolveProblem() {
  const client = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: (input: { id: string; resolved: boolean }) =>
      v1Send<{ id: string; resolvedAt: string | null }>('POST', `/admin/problems/${encodeURIComponent(input.id)}`, { resolved: input.resolved }),
    onSuccess: () => void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'admin-problems'] }),
  });
}
