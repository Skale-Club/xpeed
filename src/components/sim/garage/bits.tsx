// The small pieces the track and car screens share: a tile with a number, the shape of a track, a lap-time sparkline, the search box and
// the toggle of a list's header, and the summary strip. The look is the dashboard's (overview/parts.tsx, overview/KpiTiles.tsx).
import { useMemo, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { timeSparkPath } from '@/lib/sim/garage';
import type { TrackFile } from '@/lib/sim/track-file';

/**
 * One number of a page: a label, the value, a line under it and, when the page has one, something small (a trend, a sparkline). While the number
 * is still being worked out (`loading`) the value is a skeleton, never a zero. `testId` is the value's; the tile itself is `${testId}-tile`.
 */
export function StatTile({ label, value, sub, mono = false, loading = false, testId, children }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
  loading?: boolean;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <Card className="h-full space-y-1.5 bg-card p-3" data-testid={`${testId}-tile`}>
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="h-7 w-20" data-testid={`${testId}-loading`} />
      ) : (
        <p className={`truncate text-xl font-semibold tabular-nums leading-tight ${mono ? 'font-mono' : ''}`} data-testid={testId}>{value}</p>
      )}
      <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground" data-testid={`${testId}-sub`}>{loading ? ' ' : sub ?? ' '}</p>
      {children}
    </Card>
  );
}

/** The grid the tiles of a page sit in: two across on a phone, three from small, `xl` across from extra large. */
export function TileGrid({ children, testId, columns = 'xl:grid-cols-6' }: { children: ReactNode; testId?: string; columns?: string }) {
  return <ul className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${columns}`} data-testid={testId}>{children}</ul>;
}
export const TileItem = ({ children }: { children: ReactNode }) => <li className="min-w-0">{children}</li>;

/** The line of a lap-time sparkline: a faster lap is lower, as on the progress chart. Decorative (the numbers around it say it). */
export function TimeSparkline({ values, color, width = 96, height = 28 }: { values: readonly number[]; color: string; width?: number; height?: number }) {
  const path = useMemo(() => timeSparkPath(values, width, height), [values, width, height]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-full" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-testid="pb-spark" data-points={path.points}>
      {path.d && <path d={path.d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {path.last && <circle cx={path.last.x} cy={path.last.y} r={2} fill={color} />}
    </svg>
  );
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

/** A search box for the header of a list: a native search input, labelled, with the usual glass. */
export function SearchField({ label, value, onChange, placeholder, testId }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; testId?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <span className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4" aria-hidden="true" />
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="h-9 w-full min-w-0 rounded-md border border-border bg-background pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground/70"
          data-testid={testId}
        />
      </span>
    </label>
  );
}

/** An on/off filter as a button (`aria-pressed`), the height of the drop-downs next to it. */
export function ToggleChip({ pressed, onChange, children, testId }: { pressed: boolean; onChange: (pressed: boolean) => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      data-testid={testId}
      className={`inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        pressed ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** The numbers over a list (how many, how many laps...): small tiles, the same look as the dashboard's, written for what the list shows. */
export function SummaryStrip({ items, testId = 'summary' }: { items: Array<{ id: string; label: string; value: ReactNode; sub?: ReactNode }>; testId?: string }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid={testId}>
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <Card className="h-full space-y-1 bg-card p-3" data-testid={`${testId}-${item.id}`}>
            <p className="truncate text-xs font-medium text-muted-foreground">{item.label}</p>
            <p className="truncate text-xl font-semibold tabular-nums leading-tight" data-testid={`${testId}-${item.id}-value`}>{item.value}</p>
            <p className="min-h-4 truncate text-xs text-muted-foreground">{item.sub ?? ' '}</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** The skeleton of a list of cards: the same grid, the same card height, so nothing jumps when the cards arrive. */
export function CardGridSkeleton({ count = 6, label }: { count?: number; label: string }) {
  return (
    <div className="space-y-4" role="status" aria-label={label} data-testid="garage-skeleton">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[88px] rounded-lg" />)}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="h-44 rounded-lg" />)}
      </div>
    </div>
  );
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
    <div className="space-y-2 rounded-lg border border-dashed border-border p-4" data-testid={testId}>
      <p className="text-sm text-muted-foreground">{children}</p>
      <button type="button" onClick={onClear} className="text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{clearLabel}</button>
    </div>
  );
}
