import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TrackPath } from '@/lib/sim/analysis';
import { bandRuns, roadRuns, type Point, type RoadRun, type TrackFile } from '@/lib/sim/track-file';
import { CHART_PALETTE } from '@/lib/chart-palette';

/** At most this many points per line are drawn; a layout can have tens of thousands. */
const MAX_DRAWN_POINTS = 1500;
/** How far the picture can be zoomed in: a track of 6 km shows a stretch of about a hundred metres at this. */
const MAX_ZOOM = 64;

function thin<T>(points: T[]): T[] {
  if (points.length <= MAX_DRAWN_POINTS) return points;
  const step = points.length / MAX_DRAWN_POINTS;
  return Array.from({ length: MAX_DRAWN_POINTS }, (_, i) => points[Math.floor(i * step)]);
}

const zip = (x: ArrayLike<number>, z: ArrayLike<number>): Point[] => Array.from({ length: x.length }, (_, i) => [x[i], z[i]] as Point);

interface Drawing {
  road: RoadRun[];
  closedRing: boolean;
  centre: Point[];
  ideal: Point[] | null;
  pit: { runs: RoadRun[]; centre: Point[] } | null;
}

/** What a layout draws: the road with its edges, the centre line, the ideal line and the pit lane. */
function drawingOf(layout: TrackFile): Drawing {
  const { runs, closedRing } = roadRuns(layout);
  const c = layout.centerline;
  const pit = layout.pitlane;
  return {
    road: runs,
    closedRing,
    centre: zip(c.x, c.z),
    ideal: layout.fast ? zip(layout.fast.x, layout.fast.z) : null,
    pit: pit ? { runs: bandRuns(pit.x, pit.z, pit.left, pit.right, false).runs, centre: zip(pit.x, pit.z) } : null,
  };
}

function boundsOf(points: Point[][]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const line of points) {
    for (const [x, z] of line) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * The track seen from above. With a layout (the real circuit, read from the game's own files) it is drawn first: the road
 * between its edges, the game's ideal line and the pit lane. Over it go the lap being looked at (solid) and the reference
 * (dashed). x is to the right and z is down, the way the layout file defines them, so nothing is mirrored.
 */
export function TrackMap({ lap, reference, layout }: { lap: TrackPath; reference?: TrackPath | null; layout?: TrackFile | null }) {
  const { t } = useTranslation();
  const [view, setView] = useState<{ k: number; cx: number; cy: number; sig: string } | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const drawing = layout ? drawingOf(layout) : null;
  const paths = reference ? [lap, reference] : [lap];

  const lines: Point[][] = paths.map((p) => p.points);
  if (drawing) {
    lines.push(drawing.centre);
    for (const run of drawing.road) lines.push(run.left, run.right);
    if (drawing.pit) for (const run of drawing.pit.runs) lines.push(run.left, run.right);
    if (drawing.pit) lines.push(drawing.pit.centre);
  }
  const { minX, maxX, minZ, maxZ } = boundsOf(lines);
  const margin = Math.max(maxX - minX, maxZ - minZ) * 0.05 + 1;
  const width = maxX - minX + 2 * margin;
  const height = maxZ - minZ + 2 * margin;
  const at = ([x, z]: Point) => `${(x - minX + margin).toFixed(1)},${(z - minZ + margin).toFixed(1)}`;
  const points = (line: Point[]) => thin(line).map(at).join(' ');
  const ring = (line: Point[]) => `M${thin(line).map(at).join(' L')} Z`;
  const band = (run: RoadRun) => `M${thin(run.left).map(at).join(' L')} L${[...thin(run.right)].reverse().map(at).join(' L')} Z`;
  const [startX, startZ] = lap.points[0];
  const hasEdges = !!drawing && drawing.road.length > 0;

  // Zoom and pan. The whole track is the first view; a road a few metres wide on a track of kilometres is a hair, so the
  // person zooms in to see the lap against the edges and the ideal line. A new picture (other size) starts from the whole.
  const sig = `${width.toFixed(0)}x${height.toFixed(0)}`;
  const current = view && view.sig === sig ? view : null;
  const k = current?.k ?? 1;
  const vbW = width / k;
  const vbH = height / k;
  const keepIn = (center: number, size: number, full: number) => Math.min(Math.max(center, size / 2), full - size / 2);
  const cx = keepIn(current?.cx ?? width / 2, vbW, width);
  const cy = keepIn(current?.cy ?? height / 2, vbH, height);
  // From the whole track the first step in goes to the start, where the lap begins; after that it zooms about where it is.
  const startAt = { x: startX - minX + margin, y: startZ - minZ + margin };
  const zoom = (factor: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(1, k * factor));
    setView(k === 1 && factor > 1 ? { k: next, cx: startAt.x, cy: startAt.y, sig } : { k: next, cx, cy, sig });
  };
  // A double click zooms in on the point clicked.
  const zoomAt = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const unitsPerPixel = Math.max(vbW / (rect.width || 1), vbH / (rect.height || 1));
    const offsetX = (rect.width - vbW / unitsPerPixel) / 2;
    const offsetY = (rect.height - vbH / unitsPerPixel) / 2;
    const x = cx - vbW / 2 + (event.clientX - rect.left - offsetX) * unitsPerPixel;
    const y = cy - vbH / 2 + (event.clientY - rect.top - offsetY) * unitsPerPixel;
    setView({ k: Math.min(MAX_ZOOM, k * 2), cx: x, cy: y, sig });
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (k <= 1) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, cx, cy };
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const unitsPerPixel = Math.max(vbW / (rect.width || 1), vbH / (rect.height || 1));
    setView({ k, cx: start.cx - (event.clientX - start.x) * unitsPerPixel, cy: start.cy - (event.clientY - start.y) * unitsPerPixel, sig });
  };
  const pointerUp = () => {
    drag.current = null;
  };

  return (
    <div className="relative">
    <div className="absolute right-1 top-1 z-10 flex gap-1" data-testid="map-zoom">
      <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label={t('modes.compare.zoomIn', 'Zoom in')} onClick={() => zoom(2)} disabled={k >= MAX_ZOOM}>
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label={t('modes.compare.zoomOut', 'Zoom out')} onClick={() => zoom(0.5)} disabled={k <= 1}>
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label={t('modes.compare.zoomReset', 'Show the whole track')} onClick={() => setView(null)} disabled={k <= 1}>
        <Maximize className="h-4 w-4" />
      </Button>
    </div>
    <svg
      viewBox={`${(cx - vbW / 2).toFixed(1)} ${(cy - vbH / 2).toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`}
      preserveAspectRatio="xMidYMid meet"
      className={cn('h-64 w-full text-muted-foreground', k > 1 && 'cursor-grab touch-none active:cursor-grabbing')}
      role="img"
      aria-label={t('modes.compare.mapLabel', 'The line driven, seen from above')}
      data-testid="track-map"
      onDoubleClick={zoomAt}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
    >
      {drawing && (
        <g data-testid="track-layout">
          {/* Seen whole, the road is thinner than a pixel: this keeps it readable until it is zoomed in on. */}
          {hasEdges && (
            <polyline points={points(drawing.centre)} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          )}
          {drawing.closedRing ? (
            <path
              d={`${ring(drawing.road[0].left)} ${ring(drawing.road[0].right)}`}
              fill="currentColor" fillOpacity={0.22} fillRule="evenodd" stroke="currentColor" strokeOpacity={0.7} strokeWidth={1.5}
              vectorEffect="non-scaling-stroke" strokeLinejoin="round"
            />
          ) : (
            drawing.road.map((run, i) => (
              <path key={i} d={band(run)} fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeOpacity={0.7} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            ))
          )}
          {/* No edges known: the centre line is the track. */}
          {!hasEdges && (
            <polyline points={points(drawing.centre)} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          )}
          {drawing.pit && (
            <g data-testid="track-pitlane">
              {drawing.pit.runs.map((run, i) => (
                <path key={i} d={band(run)} fill={CHART_PALETTE.amber} fillOpacity={0.25} stroke={CHART_PALETTE.amber} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              ))}
              <polyline points={points(drawing.pit.centre)} fill="none" stroke={CHART_PALETTE.amber} strokeWidth={2} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            </g>
          )}
          {drawing.ideal && (
            <polyline points={points(drawing.ideal)} fill="none" stroke={CHART_PALETTE.red} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" data-testid="track-ideal-line" />
          )}
        </g>
      )}
      {reference && (
        <polyline points={points(reference.points)} fill="none" stroke={CHART_PALETTE.blue} strokeWidth={2.5} strokeDasharray="10 8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={0.9} />
      )}
      <polyline points={points(lap.points)} fill="none" stroke={CHART_PALETTE.yellow} strokeWidth={3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={startX - minX + margin} cy={startZ - minZ + margin} r={Math.max(width, height) * 0.012} fill={CHART_PALETTE.green} />
    </svg>
    </div>
  );
}
