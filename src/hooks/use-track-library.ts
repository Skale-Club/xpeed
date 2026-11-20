import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TrackLibraryError, listTracks, subscribeTrackLibrary, type LibraryTrack } from '@/lib/sim/track-library';
import { useUserId } from '@/lib/sim/v1-client';

export type TrackLibraryStatus = 'loading' | 'ready' | 'unavailable' | 'failed';

/** The track layouts this account has kept on the device, read again whenever they change. */
export function useTrackLibrary() {
  const userId = useUserId();
  const scope = useMemo(() => ({ userId, revision: 0 }), [userId]);
  const active = useRef(scope);
  active.current = scope;
  const [state, setState] = useState<{ scope: typeof scope; status: TrackLibraryStatus; tracks: LibraryTrack[] } | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const revision = ++scope.revision;
    const current = () => scope === active.current && scope.revision === revision;
    try {
      const tracks = await listTracks(userId);
      if (current()) setState({ scope, status: 'ready', tracks });
    } catch (error) {
      if (current()) setState({ scope, status: error instanceof TrackLibraryError && error.code === 'unavailable' ? 'unavailable' : 'failed', tracks: [] });
    }
  }, [scope, userId]);

  useEffect(() => {
    const reread = () => { void refresh(); };
    reread();
    const stop = subscribeTrackLibrary(reread);
    return () => {
      scope.revision++;
      stop();
    };
  }, [refresh, scope]);

  const visible = state?.scope === scope ? state : { status: 'loading' as const, tracks: [] };
  return { status: visible.status, tracks: visible.tracks, userId, refresh };
}
