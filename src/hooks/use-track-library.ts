import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { TrackLibraryError, listTracks, subscribeTrackLibrary, type LibraryTrack } from '@/lib/sim/track-library';

export type TrackLibraryStatus = 'loading' | 'ready' | 'unavailable' | 'failed';

/** The track layouts this account has kept on the device, read again whenever they change. */
export function useTrackLibrary() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ status: TrackLibraryStatus; tracks: LibraryTrack[] }>({ status: 'loading', tracks: [] });

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      setState({ status: 'ready', tracks: await listTracks(userId) });
    } catch (error) {
      setState({ status: error instanceof TrackLibraryError && error.code === 'unavailable' ? 'unavailable' : 'failed', tracks: [] });
    }
  }, [userId]);

  useEffect(() => {
    let live = true;
    const reread = () => {
      if (live) void refresh();
    };
    reread();
    const stop = subscribeTrackLibrary(reread);
    return () => {
      live = false;
      stop();
    };
  }, [refresh]);

  return { ...state, userId, refresh };
}
