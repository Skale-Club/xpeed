import { useEffect, useState } from 'react';
import { isAdminUser } from '@/lib/db-extras';
import { useAuth } from '@/contexts/AuthContext';

/**
 * One-shot admin status check, cached per session via the auth user id.
 * Returns { isAdmin, loading } so consumers can render placeholders while
 * the answer is in flight.
 */
const cache = new Map<string, boolean>();

export function useAdminStatus(): { isAdmin: boolean; loading: boolean } {
  const { user, loading: authLoading } = useAuth();
  const cached = user ? cache.get(user.id) : undefined;
  const [isAdmin, setIsAdmin] = useState<boolean>(cached ?? false);
  const [loading, setLoading] = useState<boolean>(cached === undefined);

  useEffect(() => {
    if (authLoading || !user) {
      setLoading(false);
      setIsAdmin(false);
      return;
    }
    if (cache.has(user.id)) {
      setIsAdmin(cache.get(user.id)!);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await isAdminUser();
        if (cancelled) return;
        cache.set(user.id, result);
        setIsAdmin(result);
      } catch {
        if (!cancelled) setIsAdmin(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, authLoading]);

  return { isAdmin, loading };
}
