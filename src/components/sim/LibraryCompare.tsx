import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { LapAnalysis, type LoadedLap } from '@/components/sim/LapAnalysis';
import { useAuth } from '@/contexts/AuthContext';
import { loadLap } from '@/lib/sim/library';
import { addTrackFile, findTrack, linkTrack, listTracks } from '@/lib/sim/track-library';
import { syncAccountTracks } from '@/lib/sim/account-tracks';

/**
 * The compare screen, starting from laps kept on this device when the address names them
 * (`?a=<lap>&b=<reference>`, as the sessions list does), and from nothing otherwise.
 */
export function LibraryCompare() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const ids = [params.get('a'), params.get('b')].filter((id): id is string => !!id);
  const key = ids.join('\n');
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ key: string; laps: LoadedLap[]; missing: boolean } | null>(null);

  // Track layouts are kept on this device like laps: one opened here is kept for next time, and a lap finds its own.
  // A layout not on this device yet may be in the account (Xpeed Companion sends them): the account is copied over once, then
  // looked in again.
  const synced = useRef<Promise<unknown> | null>(null);
  const findLayout = useCallback(
    async (game: string, trackName: string, variant?: string | null) => {
      if (!userId) return null;
      const here = await findTrack(userId, game, trackName, variant);
      if (here) return here;
      synced.current ??= syncAccountTracks(userId).catch(() => undefined);
      await synced.current;
      return findTrack(userId, game, trackName, variant);
    },
    [userId],
  );
  const listKeptLayouts = useCallback(() => (userId ? listTracks(userId) : Promise.resolve([])), [userId]);
  const linkLayout = useCallback(
    (game: string, trackName: string, variant: string | null, layoutId: string) =>
      userId ? linkTrack(userId, game, trackName, variant, layoutId) : Promise.resolve(null),
    [userId],
  );
  const keepLayout = useCallback(
    (file: File) => {
      if (userId) void addTrackFile(userId, file).catch(() => undefined);
    },
    [userId],
  );

  useEffect(() => {
    if (ids.length === 0 || !userId) return;
    let live = true;
    const label = t('modes.compare.fromSessions', 'From your sessions');
    Promise.all(
      ids.map(async (id): Promise<LoadedLap | null> => {
        try {
          const lap = await loadLap(userId, id);
          return lap ? { id, name: label, lap } : null;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (!live) return;
      const laps = results.filter((entry): entry is LoadedLap => entry !== null);
      setState({ key, laps, missing: laps.length < ids.length });
    });
    return () => {
      live = false;
    };
    // `ids` is rebuilt every render; `key` says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, userId, t]);

  if (ids.length > 0 && state?.key !== key) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading', 'Loading…')}
      </p>
    );
  }
  return (
    <>
      {state?.missing && ids.length > 0 && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {t('modes.compare.missing', 'Some of those laps are no longer on this device.')}
        </p>
      )}
      <LapAnalysis key={key} initialLaps={ids.length > 0 ? state?.laps : undefined} findLayout={findLayout} onLayoutFile={keepLayout} listKeptLayouts={listKeptLayouts} linkLayout={linkLayout} />
    </>
  );
}
