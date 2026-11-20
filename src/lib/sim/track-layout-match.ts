import { useQuery } from '@tanstack/react-query';
import { useUserId } from '@/lib/sim/v1-client';
import { accountLayoutsKey, listAccountTracks, type AccountTrack } from '@/lib/sim/account-tracks';
import { layoutGame, sameTrackIdentity } from '@/lib/sim/track-file';

const norm = (text: string | null | undefined) => (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Used for catalog metadata from older servers. An explicit source identity
 * wins. A legacy label only suggests a layout when it is unique.
 */
export function hasSyncedLayout(layouts: readonly AccountTrack[], track: { game: string; name: string; sourceName?: string | null; variant?: string | null }): boolean {
  const source = track.sourceName ?? track.name;
  if (track.sourceName || track.variant !== undefined) return layouts.some((layout) => sameTrackIdentity(
    { game: layout.game, track: { name: layout.trackName, variant: layout.variant } },
    { game: layoutGame(track.game), track: { name: source, variant: track.variant } },
  ));
  const game = norm(layoutGame(track.game));
  const name = norm(track.name);
  if (!name) return false;
  const candidates = layouts.filter((layout) => {
    if (norm(layout.game) !== game) return false;
    const base = norm(layout.trackName);
    return [base, norm(`${layout.trackName} ${layout.variant ?? ''}`), norm(layout.title)].includes(name);
  });
  return candidates.length === 1 && (!candidates[0].variant || norm(candidates[0].trackName) !== name);
}

/** The layouts the account holds (a cheap list, no file); null while unknown or when the server cannot say (the badge is then not shown). */
export function useAccountLayouts(enabled = true): AccountTrack[] | null {
  const userId = useUserId();
  const query = useQuery({
    queryKey: accountLayoutsKey(userId),
    queryFn: ({ signal }) => listAccountTracks({ userId: userId ?? undefined, signal }),
    enabled: !!userId && enabled,
    staleTime: 30_000,
    retry: false,
  });
  return query.data ?? null;
}
