import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TrackPath } from '@/lib/sim/analysis';
import { bandRuns, roadRuns, type Point, type RoadRun, type TrackFile } from '@/lib/sim/track-file';
import { CHART_PALETTE } from '@/lib/chart-palette';

/** At most this many points per line are drawn on the whole track; zoomed in, this many times the zoom. */
const MAX_DRAWN_POINTS = 1500;
/** How far the picture can be zoomed in: a track of 6 km shows a stretch of about a hundred metres at this. */
const MAX_ZOOM = 64;
/** The zoom a "show on the map" goes to. */
const FOCUS_ZOOM = 8;

function thin<T>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points;
  const step = points.length / limit;
  return Array.from({ length: limit }, (_, i) => points[Math.floor(i * step)]);
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

/** A point to bring into view (game coordinates); `key` changes each time it is asked for, even for the same point. */
export interface MapFocus {
  x: number;
  z: number;
  key: number;
  /** How much of the track to show around the point, in meters (the longer side of what must fit); the usual close-up when left out. */
  span?: number;
  /** Go back to the whole track (the point is ignored). */
  reset?: boolean;
}

/**
 * The track seen from above. With a layout (the real circuit, read from the game's own files) it is drawn first: the road
 * between its edges, the game's ideal line and the pit lane. Over it go the lap being looked at (solid) and the reference
 * (dashed). x is to the right and z is down, the way the layout file defines them, so nothing is mirrored.
 *
 * Zoom: buttons, double click, pinch, or + and - on the keyboard; zoomed in, it is dragged (or moved with the arrows).
 */
export function TrackMap({ lap, reference, layout, focus, highlight, className }: {
  /** Extra classes for the picture (a taller one on a page that makes the map its hero); the height of a lap analysis is the default. */
  className?: string;
  lap: TrackPath;
  reference?: TrackPath | null;
  layout?: TrackFile | null;
  focus?: MapFocus | null;
  /** A stretch of the lap to mark (the corner being looked at): [x, z] points, drawn over the lap. */
  highlight?: Array<[number, number]> | null;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<{ k: number; cx: number; cy: number; sig: string } | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; k: number } | null>(null);
  // Building the road is the heavy part; it is done once per layout, not on every move of the map.
  const drawing = useMemo(() => (layout ? drawingOf(layout) : null), [layout]);
  const paths = reference ? [lap, reference] : [lap];

  const bounds = useMemo(() => {
    const lines: Point[][] = paths.map((p) => p.points);
    if (drawing) {
      lines.push(drawing.centre);
      for (const run of drawing.road) lines.push(run.left, run.right);
      if (drawing.pit) for (const run of drawing.pit.runs) lines.push(run.left, run.right);
      if (drawing.pit) lines.push(drawing.pit.centre);
    }
    return boundsOf(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lap, reference, drawing]);
  const { minX, maxX, minZ, maxZ } = bounds;
  const margin = Math.max(maxX - minX, maxZ - minZ) * 0.05 + 1;
  const width = maxX - minX + 2 * margin;
  const height = maxZ - minZ + 2 * margin;
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
  const toMap = (x: number, z: number) => ({ x: x - minX + margin, y: z - minZ + margin });

  useEffect(() => {
    if (!focus) return;
    if (focus.reset) {
      setView(null);
      return;
    }
    const at = toMap(focus.x, focus.z);
    const fit = focus.span && focus.span > 0 ? Math.max(width, height) / focus.span : FOCUS_ZOOM;
    setView({ k: Math.min(MAX_ZOOM, Math.max(1, fit)), cx: at.x, cy: at.y, sig });
    // Only a new request moves the map; the rest is read as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  // Zoomed in, more of the points are drawn, so a corner stays a corner.
  const limit = Math.round(MAX_DRAWN_POINTS * Math.max(1, k));
  const at = ([x, z]: Point) => `${(x - minX + margin).toFixed(1)},${(z - minZ + margin).toFixed(1)}`;
  const points = (line: Point[]) => thin(line, limit).map(at).join(' ');
  const ring = (line: Point[]) => `M${thin(line, limit).map(at).join(' L')} Z`;
  const band = (run: RoadRun) => `M${thin(run.left, limit).map(at).join(' L')} L${[...thin(run.right, limit)].reverse().map(at).join(' L')} Z`;

  const setZoom = (next: number, centre = { x: cx, y: cy }) => setView({ k: Math.min(MAX_ZOOM, Math.max(1, next)), cx: centre.x, cy: centre.y, sig });
  // From the whole track the first step in goes to the start, where the lap begins; after that it zooms about where it is.
  const zoom = (factor: number) => setZoom(k * factor, k === 1 && factor > 1 ? toMap(startX, startZ) : undefined);
  const unitsPerPixel = (rect: DOMRect) => Math.max(vbW / (rect.width || 1), vbH / (rect.height || 1));

  // A double click zooms in on the point clicked.
  const zoomAt = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const u = unitsPerPixel(rect);
    const offsetX = (rect.width - vbW / u) / 2;
    const offsetY = (rect.height - vbH / u) / 2;
    setZoom(k * 2, { x: cx - vbW / 2 + (event.clientX - rect.left - offsetX) * u, y: cy - vbH / 2 + (event.clientY - rect.top - offsetY) * u });
  };
  const spread = () => {
    const [a, b] = [...touches.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.current.size === 2) {
      // Two fingers: a pinch, never a drag.
      pinch.current = { distance: spread(), k };
      drag.current = null;
      return;
    }
    if (k <= 1) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, cx, cy };
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && touches.current.size === 2) {
      setZoom(pinch.current.k * (spread() / pinch.current.distance));
      return;
    }
    const start = drag.current;
    if (!start) return;
    const u = unitsPerPixel(event.currentTarget.getBoundingClientRect());
    setView({ k, cx: start.cx - (event.clientX - start.x) * u, cy: start.cy - (event.clientY - start.y) * u, sig });
  };
  const pointerUp = (event: PointerEvent<SVGSVGElement>) => {
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    drag.current = null;
  };
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (event.key === '+' || event.key === '=') zoom(2);
    else if (event.key === '-') zoom(0.5);
    else if (event.key === '0') setView(null);
    else if (step && k > 1) setView({ k, cx: cx + step[0] * vbW * 0.2, cy: cy + step[1] * vbH * 0.2, sig });
    else return;
    event.preventDefault();
  };

  const start = toMap(startX, startZ);
  return (
    <div className="relative select-none">
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
        className={cn(
          'h-64 w-full rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
          // Zoomed in, a finger drags the map; on the whole track it still scrolls the page, and a pinch zooms the map.
          k > 1 ? 'cursor-grab touch-none active:cursor-grabbing' : 'touch-pan-x touch-pan-y',
          className,
        )}
        role="img"
        tabIndex={0}
        aria-label={t('modes.compare.mapLabel', 'The line driven, seen from above')}
        data-testid="track-map"
        data-zoom={k}
        onDoubleClick={zoomAt}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onKeyDown={keyDown}
      >
        {drawing && (
          <g data-testid="track-layout">
            {/* Seen whole, the road is thinner than a pixel: this keeps its shape readable until it is zoomed in on. */}
            {hasEdges && (
              <polyline points={points(drawing.centre)} fill="none" stroke="currentColor" strokeOpacity={k < 4 ? 0.3 : 0.15} strokeWidth={k < 4 ? 10 : 7} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
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
        {/* Over a layout, seen whole, the lap is drawn thinner so the road around it shows. */}
        <polyline points={points(lap.points)} fill="none" stroke={CHART_PALETTE.yellow} strokeWidth={drawing && k < 4 ? 2 : 3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {highlight && highlight.length > 1 && (
          <polyline points={points(highlight)} fill="none" stroke={CHART_PALETTE.pink} strokeWidth={4.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-testid="map-highlight" />
        )}
        {/* The start keeps its size on screen whatever the zoom. */}
        <circle cx={start.x} cy={start.y} r={Math.max(vbW, vbH) * 0.012} fill={CHART_PALETTE.green} />
      </svg>
    </div>
  );
}
