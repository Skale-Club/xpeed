// What the track and car screens read beyond the lists: one detail per card (read when the card is on screen), all the laps of a track or a car
// (a few pages, for the numbers the detail does not carry), and the layout of a track. They share the query keys of the plain hooks in
// v1-client.ts, so a detail read for a card is the same answer the page of that track or car opens with.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { downloadAccountTrack } from '@/lib/sim/account-tracks';
import { readTrackFile } from '@/lib/sim/read-track-file';
import { layoutGame, type TrackFile } from '@/lib/sim/track-file';
import { useLayoutFinder } from '@/lib/sim/use-track-layouts';
import { STALE, useLaps, usePbs, useUserId, v1Get, v1Keys, type LapFilters, type PbFilters, type V1CarDetail, type V1Lap, type V1Pb, type V1TrackDetail } from '@/lib/sim/v1-client';

/** One track with its progress, read only when `enabled` (a card that is on screen). Same key as `useTrack`. */
export function useTrackDetail(id: string | null, enabled: boolean) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.track(userId, id),
    queryFn: () => v1Get<V1TrackDetail>(`/tracks/${encodeURIComponent(id ?? '')}`),
    enabled: !!userId && !!id && enabled,
    staleTime: STALE.detail,
    retry: false,
  });
}

/** One car with its progress, read only when `enabled`. Same key as `useCar`. */
export function useCarDetail(id: string | null, enabled: boolean) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.car(userId, id),
    queryFn: () => v1Get<V1CarDetail>(`/cars/${encodeURIComponent(id ?? '')}`),
    enabled: !!userId && !!id && enabled,
    staleTime: STALE.detail,
    retry: false,
  });
}

/** Becomes true (and stays true) once the element is on screen, or about to be; true at once where the browser cannot tell. */
export function useOnScreen<T extends Element>(margin = '200px'): [(node: T | null) => void, boolean] {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const observer = useRef<IntersectionObserver | null>(null);
  const attach = (node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || seen || typeof IntersectionObserver === 'undefined') return;
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.current?.disconnect();
      }
    }, { rootMargin: margin });
    observer.current.observe(node);
  };
  useEffect(() => () => observer.current?.disconnect(), []);
  return [attach, seen];
}

/** The most laps a page reads for its numbers: 10 pages of 50 (more are said so on the screen, the figures then cover the latest ones). */
export const MAX_LAP_PAGES = 10;

/**
 * Every lap of a track or a car, newest first, read page after page (up to `MAX_LAP_PAGES`). `complete` is false while pages remain, or when the
 * cap was reached with more behind it; `capped` says the latter, so a figure built from these laps can say it covers the latest ones.
 */
export function useAllLaps(filters: LapFilters, enabled = true) {
  const query = useLaps(filters, { enabled });
  const pages = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (enabled && query.hasNextPage && !query.isFetching && pages < MAX_LAP_PAGES) void query.fetchNextPage();
  }, [query, pages, enabled]);
  const capped = !!query.hasNextPage && pages >= MAX_LAP_PAGES;
  return { laps: query.items as V1Lap[], isPending: query.isPending, isError: query.isError, loading: query.isPending || (!!query.hasNextPage && !capped), complete: !query.hasNextPage, capped };
}

/** The personal bests of the person (every car), read page after page, for the best lap on each track. */
export function useAllPbs(filters: PbFilters = {}, enabled = true) {
  const query = usePbs(filters, { enabled });
  const pages = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (enabled && query.hasNextPage && !query.isFetching && pages < MAX_LAP_PAGES) void query.fetchNextPage();
  }, [query, pages, enabled]);
  return { pbs: query.items as V1Pb[], isPending: query.isPending, isError: query.isError, loading: query.isPending || !!query.hasNextPage };
}

/**
 * The layout of a track (its shape), read only when `enabled`. With the id of the layout the account holds (the server says it) the one file is
 * downloaded; without it (an older server) the layout is looked for by game and name on the device and in the account, as the compare screen
 * does. Null when there is none; kept for the visit.
 */
export function useTrackLayout(track: { game: string; name: string; layoutId?: string | null } | null, enabled: boolean) {
  const userId = useAuth().user?.id ?? null;
  const { findLayout } = useLayoutFinder();
  return useQuery<TrackFile | null>({
    queryKey: ['sim-track-layout', userId, track?.layoutId ?? `${track?.game}|${track?.name}`],
    queryFn: async () => {
      if (!track) return null;
      if (track.layoutId) {
        // The server named the layout: that file is the answer. If it cannot be had or read there is no shape (and no hunting by name).
        try {
          const blob = await downloadAccountTrack(track.layoutId);
          return blob ? await readTrackFile(blob) : null;
        } catch {
          return null;
        }
      }
      return findLayout(layoutGame(track.game), track.name);
    },
    enabled: !!userId && !!track && enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
