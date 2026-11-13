import { useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { syncAccountTracks } from '@/lib/sim/account-tracks';
import type { TrackFile } from '@/lib/sim/track-file';
import { findTrack, linkTrack, listTracks, type LibraryTrack } from '@/lib/sim/track-library';

/**
 * Where a screen finds the layout of a track (the real shape of the circuit Xpeed Companion sent to the account): in the copy kept
 * on this device, and, the first time one is missing, after the account's layouts have been copied onto the device once.
 */
export function useLayoutFinder() {
  const userId = useAuth().user?.id ?? null;
  const synced = useRef<Promise<unknown> | null>(null);
  const findLayout = useCallback(
    async (game: string, trackName: string, variant?: string | null): Promise<TrackFile | null> => {
      if (!userId) return null;
      const here = await findTrack(userId, game, trackName, variant);
      if (here) return here;
      synced.current ??= syncAccountTracks(userId).catch(() => undefined);
      await synced.current;
      return findTrack(userId, game, trackName, variant);
    },
    [userId],
  );
  const listKeptLayouts = useCallback((): Promise<LibraryTrack[]> => (userId ? listTracks(userId) : Promise.resolve([])), [userId]);
  const linkLayout = useCallback(
    (game: string, trackName: string, variant: string | null, layoutId: string) => (userId ? linkTrack(userId, game, trackName, variant, layoutId) : Promise.resolve(null)),
    [userId],
  );
  return { findLayout, listKeptLayouts, linkLayout };
}
