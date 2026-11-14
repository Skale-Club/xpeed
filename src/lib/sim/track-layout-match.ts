import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { listAccountTracks, type AccountTrack } from '@/lib/sim/account-tracks';
import { layoutGame } from '@/lib/sim/track-file';

const norm = (text: string | null | undefined) => (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether Xpeed Companion has sent a layout (the real shape of the circuit) for a track of the catalog. A layout is named the way
 * the game names the track, so the match is by game and name (accents, case and punctuation do not count): the layout's track name,
 * its name with the layout variant, or its title.
 */
export function hasSyncedLayout(layouts: readonly AccountTrack[], track: { game: string; name: string }): boolean {
  const game = norm(layoutGame(track.game));
  const name = norm(track.name);
  if (!name) return false;
  return layouts.some((layout) => {
    if (norm(layout.game) !== game) return false;
    return [layout.trackName, `${layout.trackName} ${layout.variant ?? ''}`, layout.title].some((candidate) => norm(candidate) === name);
  });
}

/** The layouts the account holds (a cheap list, no file); null while unknown or when the server cannot say (the badge is then not shown). */
export function useAccountLayouts(enabled = true): AccountTrack[] | null {
  const userId = useAuth().user?.id ?? null;
  const query = useQuery({
    queryKey: ['sim-account-layouts', userId],
    queryFn: async () => (await listAccountTracks()) ?? [],
    enabled: !!userId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return query.data ?? null;
}
