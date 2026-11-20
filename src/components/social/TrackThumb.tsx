import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadAccountTrack } from '@/lib/sim/account-tracks';
import { readTrackFile } from '@/lib/sim/read-track-file';
import type { TrackFile } from '@/lib/sim/track-file';
import { thumbPath } from '@/lib/sim/track-thumb';
import { useUserId } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';

/** What stands where the circuit's shape would be: a pin on a quiet square (a track with no layout sent, or one that could not be read). */
function Placeholder({ className }: { className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-muted-foreground', className)} aria-hidden="true" data-testid="track-thumb-none">
      <MapPin className="h-1/2 max-h-6 w-1/2 max-w-6" />
    </span>
  );
}

/**
 * The shape of a circuit seen from above, small: the track layout Xpeed Companion sent for it, read from the account (`layoutId` is the id the
 * tracks list gives). Without a layout, or while it loads or when it cannot be read, a quiet placeholder takes its place: nothing jumps.
 */
export function TrackThumb({ layoutId, name, className = 'h-24 w-24' }: { layoutId: string | null | undefined; name: string; className?: string }) {
  const userId = useUserId();
  const layout = useQuery({
    queryKey: ['sim-layout-thumb', userId, layoutId],
    enabled: !!userId && !!layoutId,
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const blob = await downloadAccountTrack(layoutId ?? '');
      if (!blob) throw new Error('layout unavailable');
      return readTrackFile(blob);
    },
  });
  return <TrackOutline layout={layoutId ? layout.data ?? null : null} pending={!!layoutId && layout.isPending} name={name} className={className} />;
}

/**
 * The drawing of a thumbnail once the layout is known (or not): the outline, a skeleton while it is `pending`, the placeholder when there is
 * none. `TrackThumb` and the thumbnails found by track id share it, so every small map of the site looks the same.
 */
export function TrackOutline({ layout, pending, name, className = 'h-24 w-24', decorative = false, lineWidth }: {
  layout: TrackFile | null;
  pending: boolean;
  name: string;
  className?: string;
  /** Next to the track's name the map says nothing more: hidden from screen readers. */
  decorative?: boolean;
  /** The line in screen pixels, for the small maps of a list; without it the line scales with the map. */
  lineWidth?: number;
}) {
  const { t } = useTranslation();
  const path = useMemo(() => (layout ? thumbPath(layout.centerline.x, layout.centerline.z, { closed: layout.header.closed }) : null), [layout]);
  if (pending) return <Skeleton className={cn('shrink-0 rounded-lg', className)} data-testid="track-thumb-loading" />;
  if (!path?.d) return <Placeholder className={className} />;
  return (
    <svg
      viewBox="0 0 100 100"
      {...(decorative ? { 'aria-hidden': true, focusable: false } : { role: 'img', 'aria-label': t('social.leaderboard.mapLabel', 'Map of {{track}}', { track: name }) })}
      className={cn('shrink-0 rounded-lg border border-border bg-muted/30 text-primary', className)}
      data-testid="track-thumb"
    >
      {/* A small map keeps a line that can be seen (screen pixels); a big one draws it in the drawing's units. */}
      <path d={path.d} fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" {...(lineWidth ? { strokeWidth: lineWidth, vectorEffect: 'non-scaling-stroke' } : { strokeWidth: 3 })} />
    </svg>
  );
}
