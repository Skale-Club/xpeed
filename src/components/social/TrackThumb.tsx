import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadAccountTrack } from '@/lib/sim/account-tracks';
import { readTrackFile } from '@/lib/sim/read-track-file';
import { thumbPath } from '@/lib/sim/track-thumb';
import { useUserId } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';

/** What stands where the circuit's shape would be: a pin on a quiet square (a track with no layout sent, or one that could not be read). */
function Placeholder({ className }: { className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-muted-foreground', className)} aria-hidden="true" data-testid="track-thumb-none">
      <MapPin className="h-6 w-6" />
    </span>
  );
}

/**
 * The shape of a circuit seen from above, small: the track layout Xpeed Companion sent for it, read from the account (`layoutId` is the id the
 * tracks list gives). Without a layout, or while it loads or when it cannot be read, a quiet placeholder takes its place: nothing jumps.
 */
export function TrackThumb({ layoutId, name, className = 'h-24 w-24' }: { layoutId: string | null | undefined; name: string; className?: string }) {
  const { t } = useTranslation();
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
  const path = useMemo(() => (layout.data ? thumbPath(layout.data.centerline.x, layout.data.centerline.z, { closed: layout.data.header.closed }) : null), [layout.data]);

  if (!layoutId) return <Placeholder className={className} />;
  if (layout.isPending) return <Skeleton className={cn('shrink-0 rounded-lg', className)} data-testid="track-thumb-loading" />;
  if (!path?.d) return <Placeholder className={className} />;
  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={t('social.leaderboard.mapLabel', 'Map of {{track}}', { track: name })}
      className={cn('shrink-0 rounded-lg border border-border bg-muted/30 text-primary', className)}
      data-testid="track-thumb"
    >
      <path d={path.d} fill="none" stroke="currentColor" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
