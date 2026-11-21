// The small pieces the track and car screens share: a tile with a number, the shape of a track, a lap-time sparkline, the search box and
// the toggle of a list's header, and the summary strip. The look is the dashboard's (overview/parts.tsx, overview/KpiTiles.tsx).
import { useMemo, type ReactNode } from 'react';
import { Chip } from '@/components/ui/chip';
import { SearchField as UiSearchField } from '@/components/ui/filter-fields';
import { FILTER_CELL } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatGrid, StatTile as UiStatTile } from '@/components/ui/stat-tile';
import { timeSparkPath } from '@/lib/sim/garage';
import type { TrackFile } from '@/lib/sim/track-file';
import { cn } from '@/lib/utils';
import { SparkSvg } from '../overview/parts';

/**
 * One number of a page: a label, the value, a line under it and, when the page has one, something small (a trend, a sparkline). While the number
 * is still being worked out (`loading`) the value is a skeleton, never a zero. `testId` is the value's; the tile itself is `${testId}-tile`.
 * A thin adapter over the shared `StatTile`.
 */
export function StatTile({ label, value, sub, loading = false, testId, children }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Lap times are set in the monospaced face; the shared tile always does. */
  mono?: boolean;
  loading?: boolean;
  testId: string;
  children?: ReactNode;
}) {
  // Dashboards 2027, phase 3 (owner approved 2026-11-20): the shared `feature` look, as on the Overview.
  return <UiStatTile size="feature" label={label} value={value} hint={loading ? undefined : sub} loading={loading} testId={`${testId}-tile`} valueTestId={testId} subTestId={`${testId}-sub`} footer={children} />;
}

type GridColumns = NonNullable<Parameters<typeof StatGrid>[0]['columns']>;

/** The grid the tiles of a page sit in: the shared `StatGrid`, two across on a phone, three from small, `xl` across from extra large (6 unless `columns` says otherwise). */
export function TileGrid({ children, testId, columns = { xl: 6 } }: { children: ReactNode; testId?: string; columns?: GridColumns }) {
  return <StatGrid columns={columns} testId={testId}>{children}</StatGrid>;
}
/** A tile of the grid; the shared `StatTile` is already the list item, so this only passes its child through. */
export const TileItem = ({ children }: { children: ReactNode }) => <>{children}</>;

/** The line of a lap-time sparkline: a faster lap is lower, as on the progress chart. Decorative (the numbers around it say it). */
export function TimeSparkline({ values, color, width = 96, height = 28 }: { values: readonly number[]; color: string; width?: number; height?: number }) {
  const path = useMemo(() => timeSparkPath(values, width, height), [values, width, height]);
  return <SparkSvg path={path} color={color} width={width} height={height} testId="pb-spark" />;
}

/** The centre line of a layout as a picture (z down, as the big map draws it); nothing when the layout has no usable points. */
export function TrackShape({ layout, className = '', testId = 'track-shape', strokeWidth = 2.5 }: { layout: TrackFile; className?: string; testId?: string; strokeWidth?: number }) {
  const shape = useMemo(() => {
    const { x, z } = layout.centerline;
    const step = Math.max(1, Math.ceil(x.length / 400));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const raw: Array<[number, number]> = [];
    for (let i = 0; i < x.length; i += step) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(z[i])) continue;
      raw.push([x[i], z[i]]);
      minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
      minZ = Math.min(minZ, z[i]); maxZ = Math.max(maxZ, z[i]);
    }
    if (raw.length < 2) return null;
    const margin = Math.max(maxX - minX, maxZ - minZ) * 0.08 + 1;
    return {
      view: `0 0 ${(maxX - minX + 2 * margin).toFixed(0)} ${(maxZ - minZ + 2 * margin).toFixed(0)}`,
      points: raw.map(([px, pz]) => `${(px - minX + margin).toFixed(0)},${(pz - minZ + margin).toFixed(0)}`).join(' '),
      start: { x: raw[0][0] - minX + margin, y: raw[0][1] - minZ + margin, r: Math.max(maxX - minX, maxZ - minZ) * 0.025 + 1 },
    };
  }, [layout]);
  if (!shape) return null;
  return (
    <svg viewBox={shape.view} preserveAspectRatio="xMidYMid meet" className={`text-primary ${className}`} aria-hidden="true" focusable="false" data-testid={testId}>
      <polyline points={shape.points} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={shape.start.x} cy={shape.start.y} r={shape.start.r} fill="hsl(var(--success))" />
    </svg>
  );
}

/** A search box for the bar over a list: the shared `SearchField` (small, the magnifier inside, the label is its accessible name). */
export function SearchField({ label, value, onChange, placeholder, testId, className }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; testId?: string; className?: string }) {
  return <UiSearchField label={label} value={value} onChange={onChange} placeholder={placeholder} testId={testId} className={className} />;
}

/** An on/off filter as a button (`aria-pressed`), the size of the drop-downs next to it (h-8, text-xs): the shared `Chip` as a toggle. */
export function ToggleChip({ pressed, onChange, children, icon, testId, className }: { pressed: boolean; onChange: (pressed: boolean) => void; children: ReactNode; icon?: ReactNode; testId?: string; className?: string }) {
  return (
    <Chip selected={pressed} onClick={() => onChange(!pressed)} icon={icon} testId={testId} className={cn(FILTER_CELL, 'h-8 gap-1.5 whitespace-nowrap px-2.5 text-xs focus-visible:ring-1', className)}>
      {children}
    </Chip>
  );
}

/** The numbers over a list (how many, how many laps...): small tiles, written for what the list shows. */
export function SummaryStrip({ items, testId = 'summary' }: { items: Array<{ id: string; label: string; value: ReactNode; sub?: ReactNode }>; testId?: string }) {
  return (
    <StatGrid columns={{ sm: 4, lg: null }} testId={testId}>
      {items.map((item) => (
        <UiStatTile key={item.id} label={item.label} value={item.value} hint={item.sub} testId={`${testId}-${item.id}`} />
      ))}
    </StatGrid>
  );
}

/** The skeleton of a list of cards: the shared loading state, so nothing jumps when the cards arrive. */
export function CardGridSkeleton({ count = 6, label }: { count?: number; label: string }) {
  return <LoadingState variant="cards" rows={count} label={label} testId="garage-skeleton" />;
}

/** The skeleton of a track or car page: the header, the tiles and the blocks in the places they will be, so nothing jumps when the numbers arrive. */
export function DetailSkeleton({ label, tiles = 8 }: { label: string; tiles?: number }) {
  return (
    <div className="space-y-4" role="status" aria-label={label} data-testid="garage-skeleton">
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-7 xl:grid-cols-4">
          {Array.from({ length: tiles }, (_, i) => <Skeleton key={i} className="h-[88px] rounded-lg" />)}
        </div>
        <Skeleton className="h-64 rounded-lg lg:col-span-5" />
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <Skeleton className="h-80 rounded-lg lg:col-span-8" />
        <Skeleton className="h-80 rounded-lg lg:col-span-4" />
      </div>
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}

/** The words of a list that has nothing to show for the filters chosen, with the way out. */
export function NoResults({ children, onClear, clearLabel, testId }: { children: ReactNode; onClear: () => void; clearLabel: string; testId: string }) {
  return (
    <EmptyState
      compact
      title={children}
      action={<button type="button" onClick={onClear} className="text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{clearLabel}</button>}
      testId={testId}
    />
  );
}
