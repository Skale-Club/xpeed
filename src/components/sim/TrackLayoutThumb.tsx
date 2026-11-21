import { TrackOutline } from '@/components/social/TrackThumb';
import { useOnScreen, useTrackDetail, useTrackLayout } from '@/lib/sim/garage-queries';
import { cn } from '@/lib/utils';

/**
 * The small map of a track found by its id, for every list whose rows are about a track (the progress panel, the latest sessions, the sessions
 * list, the best lap per track of a car...): the left column of the row, so the circuit is seen before its name is read. The track's detail
 * says which layout the account holds (the same answer the track page opens with); the layout is then the one the track page draws. Both are
 * read only when the row comes on screen and kept for the visit, so a list that names the same track ten times reads it once. A track with no
 * layout keeps a quiet placeholder of the same size: the names stay lined up.
 */
export function TrackLayoutThumb({ trackId, name, className = 'h-10 w-10' }: { trackId: string | null | undefined; name: string; className?: string }) {
  const [attach, seen] = useOnScreen<HTMLSpanElement>();
  const detail = useTrackDetail(trackId ?? null, seen);
  const track = detail.data?.track;
  // The whole track, as the track page passes it: the layout file is checked against the raw catalog name (`sourceName`) and the variant, and an
  // AC track's `name` is its real title ("Laguna Seca" for `ks_laguna_seca`), which never matches the file.
  const wanted = track && track.hasLayout !== false ? track : null;
  const layout = useTrackLayout(wanted, seen);
  // isLoading, not isPending: a read that never starts (signed out) ends on the placeholder, not on a skeleton forever.
  const pending = !!trackId && (!seen || detail.isLoading || (!!wanted && layout.isLoading));
  return (
    <span ref={attach} className={cn('flex shrink-0', className)} data-testid="track-layout-thumb">
      <TrackOutline layout={layout.data ?? null} pending={pending} name={name} className="h-full w-full" decorative lineWidth={1.75} />
    </span>
  );
}
