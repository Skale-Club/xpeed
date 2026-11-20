import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserId } from '@/lib/sim/v1-client';
import { accountLayoutsKey, listAccountTracks, openAccountTrack, TrackRequestError } from '@/lib/sim/account-tracks';
import { sameTrackIdentity, type TrackFile } from '@/lib/sim/track-file';
import { findTrack, linkTrack, listTracks, type LibraryTrack } from '@/lib/sim/track-library';

/**
 * Refreshes a single exact layout against the account's directory. The local
 * library remains available offline, including layouts the user linked by hand.
 */
export function useLayoutFinder() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const account = useMemo(() => ({ userId, requests: new Set<AbortController>() }), [userId]);
  const active = useRef(account);
  active.current = account;
  useEffect(() => () => account.requests.forEach((request) => request.abort()), [account]);
  const findLayout = useCallback(
    async (game: string, trackName: string, variant?: string | null): Promise<TrackFile | null> => {
      const { userId: ownerId, requests } = account;
      if (!ownerId || active.current !== account) return null;
      const request = new AbortController();
      const { signal } = request;
      requests.add(request);
      try {
        const local = await findTrack(ownerId, game, trackName, variant);
        signal.throwIfAborted();
        const directory = await queryClient.fetchQuery({
          queryKey: accountLayoutsKey(ownerId),
          queryFn: ({ signal: directorySignal }) => listAccountTracks({ userId: ownerId, signal: directorySignal }),
          staleTime: 0,
          retry: false,
        }).catch((error: unknown) => {
          if (local && error instanceof TrackRequestError && (error.status === 0 || error.status >= 500)) return null;
          throw error;
        });
        signal.throwIfAborted();
        const entry = directory?.find((item) => sameTrackIdentity(
          { game: item.game, track: { name: item.trackName, variant: item.variant } },
          { game, track: { name: trackName, variant } },
        ));
        if (!entry) return active.current === account ? local : null;
        const { track } = await openAccountTrack(ownerId, entry, signal);
        if (!track) throw new TrackRequestError(404);
        return active.current === account ? track : null;
      } finally {
        requests.delete(request);
      }
    },
    [account, queryClient],
  );
  const listKeptLayouts = useCallback(async (): Promise<LibraryTrack[]> => {
    const tracks = account.userId ? await listTracks(account.userId) : [];
    return active.current === account ? tracks : [];
  }, [account]);
  const linkLayout = useCallback(
    async (game: string, trackName: string, variant: string | null, layoutId: string) => {
      if (!account.userId || active.current !== account) return null;
      const track = await linkTrack(account.userId, game, trackName, variant, layoutId);
      return active.current === account ? track : null;
    },
    [account],
  );
  return { findLayout, listKeptLayouts, linkLayout };
}
