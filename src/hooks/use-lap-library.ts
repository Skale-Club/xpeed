import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { LibraryError, listLaps, subscribeLibrary, type LibraryLap } from '@/lib/sim/library';

export type LibraryStatus = 'loading' | 'ready' | 'unavailable' | 'failed';

/** The laps this account has kept on the device, read again whenever they change. */
export function useLapLibrary() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ status: LibraryStatus; laps: LibraryLap[] }>({ status: 'loading', laps: [] });

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      setState({ status: 'ready', laps: await listLaps(userId) });
    } catch (error) {
      setState({ status: error instanceof LibraryError && error.code === 'unavailable' ? 'unavailable' : 'failed', laps: [] });
    }
  }, [userId]);

  useEffect(() => {
    let live = true;
    const reread = () => {
      if (live) void refresh();
    };
    reread();
    const stop = subscribeLibrary(reread);
    return () => {
      live = false;
      stop();
    };
  }, [refresh]);

  return { ...state, userId, refresh };
}
