import type { LapFile } from './lap-file';
import { layoutGame, leftNormals, type Point, type TrackFile } from './track-file';

export interface PerspectiveSample {
  x: number; z: number; t: number; dist: number; arc: number; run: number; index: number;
  speed: number; throttle: number; brake: number;
}
export interface PerspectiveLap {
  points: PerspectiveSample[];
  runs: PerspectiveSample[][];
  startTime: number;
  endTime: number;
  spatial: Map<string, PerspectiveSample[]>;
}
export interface RoadCross { x: number; z: number; arc: number; run: number; left: Point; right: Point }
export interface PerspectiveRoad { points: RoadCross[]; matched: boolean; spatial: Map<string, RoadCross[]> }
export interface PerspectiveCamera {
  x: number; z: number; tx: number; tz: number;
  width: number; height: number; zoom: number; tilt: number;
}
export interface PerspectiveDrawing {
  study: string; reference: string; road: string; edges: string; highlight: string;
  anchor: Point; ahead: number; hasEdges: boolean;
}
const finite = Number.isFinite;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const cellKey = (x: number, z: number) => `${Math.floor(x / 50)},${Math.floor(z / 50)}`;
function spatialIndex<T extends { x: number; z: number; arc: number; run: number }>(points: T[]): Map<string, T[]> {
  const grid = new Map<string, T[]>(); let previous: T | undefined;
  for (const p of points) {
    if (previous && previous.run === p.run && p.arc - previous.arc < 1) continue;
    const key = cellKey(p.x, p.z), bucket = grid.get(key) ?? []; bucket.push(p); grid.set(key, bucket); previous = p;
  }
  return grid;
}
function nearby<T>(grid: Map<string, T[]>, x: number, z: number): T[] {
  const out: T[] = [], cx = Math.floor(x / 50), cz = Math.floor(z / 50);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(grid.get(`${cx + dx},${cz + dz}`) ?? []));
  return out;
}
function arcBound<T extends { arc: number }>(points: T[], arc: number): number {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].arc < arc) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Keep each missing sample, clock gap and position jump as a real break, never a connecting chord. */
export function preparePerspectiveLap(lap: LapFile): PerspectiveLap {
  const { x, z, t, dist, speed, throttle, brake } = lap.data;
  const points: PerspectiveSample[] = [], runs: PerspectiveSample[][] = [];
  const gapLimit = Math.max(1, 4 / Math.max(1, lap.header.sampleRateHz));
  let broken = true, arc = 0, previous: PerspectiveSample | undefined;
  const count = Math.min(lap.header.sampleCount, x?.length ?? 0, z?.length ?? 0, t?.length ?? 0);
  for (let i = 0; i < count; i++) {
    if (![x[i], z[i], t[i]].every(finite) || (previous && t[i] < previous.t)) { broken = true; continue; }
    const dt = previous ? t[i] - previous.t : 0;
    const step = previous ? Math.hypot(x[i] - previous.x, z[i] - previous.z) : 0;
    if (previous && (dt > gapLimit || step > Math.max(30, dt * 150))) broken = true;
    if (broken) runs.push([]);
    else arc += step;
    const point: PerspectiveSample = {
      x: x[i], z: z[i], t: t[i], dist: finite(dist?.[i]) ? dist[i] : arc,
      arc, run: runs.length - 1, index: i,
      speed: speed?.[i] ?? NaN, throttle: throttle?.[i] ?? NaN, brake: brake?.[i] ?? NaN,
    };
    runs[runs.length - 1].push(point); points.push(point); previous = point; broken = false;
  }
  return { points, runs, startTime: points[0]?.t ?? 0, endTime: points[points.length - 1]?.t ?? 0, spatial: spatialIndex(points) };
}

function upperTime(points: PerspectiveSample[], time: number): number {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].t <= time) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo - 1);
}

/** Playback follows the recorded clock, including repeated timestamps, and shows no position inside a missing span. */
export function perspectiveAtTime(lap: PerspectiveLap, time: number): PerspectiveSample | null {
  const points = lap.points;
  if (!points.length || !finite(time)) return null;
  const index = upperTime(points, time), a = points[index], b = points[index + 1];
  if (!b || time <= a.t) return a;
  if (a.run !== b.run) return null;
  const fraction = clamp((time - a.t) / (b.t - a.t || 1), 0, 1);
  const lerp = (v: number, w: number) => finite(v) && finite(w) ? v + (w - v) * fraction : NaN;
  return { ...a, x: lerp(a.x, b.x), z: lerp(a.z, b.z), t: time, dist: lerp(a.dist, b.dist), arc: lerp(a.arc, b.arc), speed: lerp(a.speed, b.speed), throttle: lerp(a.throttle, b.throttle), brake: lerp(a.brake, b.brake) };
}

function pointAtArc(run: PerspectiveSample[], arc: number): PerspectiveSample {
  let lo = 0, hi = run.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (run[mid].arc < arc) lo = mid; else hi = mid; }
  const a = run[lo], b = run[hi], f = clamp((arc - a.arc) / (b.arc - a.arc || 1), 0, 1);
  return { ...a, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

/** A spatial 16 m window damps recording jitter without introducing a playback-rate-dependent heading lag. */
export function perspectiveHeading(lap: PerspectiveLap, sample: PerspectiveSample): Point | null {
  const run = lap.runs[sample.run];
  if (!run || run.length < 2) return null;
  const a = pointAtArc(run, sample.arc - 8), b = pointAtArc(run, sample.arc + 8);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return length > 0.01 ? [(b.x - a.x) / length, (b.z - a.z) / length] : null;
}

export function nearestPerspectiveSample(lap: PerspectiveLap, x: number, z: number): PerspectiveSample | null {
  if (!finite(x) || !finite(z)) return null;
  let nearest: PerspectiveSample | null = null, distance = Infinity;
  for (const p of lap.points) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < distance) { distance = d; nearest = p; } }
  return nearest;
}

/** Coordinates and widths are read in the game's own frame; a mismatched layout is never fitted or stretched. */
export function preparePerspectiveRoad(layout: TrackFile | null | undefined, lap: LapFile, model: PerspectiveLap): PerspectiveRoad {
  const unavailable = (): PerspectiveRoad => ({ points: [], matched: false, spatial: new Map() });
  if (!layout || layoutGame(lap.header.game).trim().toLowerCase() !== layout.header.game.trim().toLowerCase()) return unavailable();
  const c = layout.centerline, normals = leftNormals(c.x, c.z, layout.header.closed), points: RoadCross[] = [];
  let arc = 0, run = 0, previous = -1;
  for (let i = 0; i < c.x.length; i++) {
    if (![c.x[i], c.z[i], c.left[i], c.right[i]].every(finite) || c.left[i] <= 0 || c.right[i] <= 0) { previous = -1; run++; continue; }
    const step = previous < 0 ? 0 : Math.hypot(c.x[i] - c.x[previous], c.z[i] - c.z[previous]);
    if (step > 50) run++;
    arc += step;
    const [nx, nz] = normals[i];
    if (!finite(nx) || !finite(nz)) { previous = -1; run++; continue; }
    const last = points[points.length - 1];
    if (!last || last.run !== run || arc - last.arc >= 2 || i === c.x.length - 1) points.push({ x: c.x[i], z: c.z[i], arc, run, left: [c.x[i] + nx * c.left[i], c.z[i] + nz * c.left[i]], right: [c.x[i] - nx * c.right[i], c.z[i] - nz * c.right[i]] });
    previous = i;
  }
  if (points.length < 2 || !model.points.length) return unavailable();
  const offsets: number[] = [];
  for (let i = 0; i < model.points.length; i += Math.max(1, Math.ceil(model.points.length / 24))) {
    const p = model.points[i]; let d = Infinity;
    for (const q of points) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
    offsets.push(d);
  }
  offsets.sort((a, b) => a - b);
  const matched = offsets[Math.floor(offsets.length / 2)] <= 25;
  return { points: matched ? points : [], matched, spatial: matched ? spatialIndex(points) : new Map() };
}

type CameraPoint = [number, number, number];
export function createPerspectiveProjector(camera: PerspectiveCamera) {
  const width = finite(camera.width) ? Math.max(1, camera.width) : 736;
  const height = finite(camera.height) ? Math.max(1, camera.height) : 400;
  const pitch = clamp(finite(camera.tilt) ? camera.tilt : 32, 20, 55) * Math.PI / 180;
  const zoom = clamp(finite(camera.zoom) ? camera.zoom : 1, .75, 1.6);
  const c = Math.cos(pitch), s = Math.sin(pitch), back = 49, altitude = 29;
  const focal = Math.min(width * .95, 420) * zoom, anchor: Point = [width / 2, height * .76];
  const depth0 = c * back + s * altitude, vertical0 = s * back - c * altitude;
  const cy = anchor[1] + focal * vertical0 / depth0;
  const toCamera = ([x, z]: Point): CameraPoint => {
    const dx = x - camera.x, dz = z - camera.z;
    const lateral = dx * camera.tz - dz * camera.tx, forward = dx * camera.tx + dz * camera.tz;
    return [lateral, s * (forward + back) - c * altitude, c * (forward + back) + s * altitude];
  };
  const screen = (p: CameraPoint): Point => [anchor[0] + focal * p[0] / p[2], cy - focal * p[1] / p[2]];
  const project = (p: Point): Point | null => { const q = toCamera(p); return q.every(finite) && q[2] >= 8 ? screen(q) : null; };
  const polygon = (points: Point[]): Point[] => {
    const input = points.map(toCamera); if (!input.flat().every(finite)) return [];
    const out: CameraPoint[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length], ain = a[2] >= 8, bin = b[2] >= 8;
      if (ain) out.push(a);
      if (ain !== bin) { const f = (8 - a[2]) / (b[2] - a[2]); out.push(a.map((v, k) => v + (b[k] - v) * f) as CameraPoint); }
    }
    return out.map(screen);
  };
  return { project, polygon, anchor };
}

export const perspectiveGroundAlpha = (screenY: number, height = 400) => clamp((height - screenY) / (height * .28), 0, 1);
function svgPath(points: Array<Point | null>, close = false): string {
  let d = '', open = false;
  for (const p of points) { if (!p || !p.every(finite)) { open = false; continue; } d += `${open ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`; open = true; }
  return d + (close && open ? 'Z' : '');
}

function localLine(model: PerspectiveLap, sample: PerspectiveSample, ahead: number): PerspectiveSample[] {
  const run = model.runs[sample.run] ?? [];
  const from = arcBound(run, sample.arc - 35), to = arcBound(run, sample.arc + ahead), count = to - from;
  // A stationary/high-rate recording must not turn a 300 m local view into hundreds of thousands of SVG vertices.
  const step = Math.max(1, Math.ceil(count / 450)), points: PerspectiveSample[] = [];
  for (let i = from; i < to; i += step) points.push(run[i]);
  if (to > from && points[points.length - 1] !== run[to - 1]) points.push(run[to - 1]);
  return points;
}

export function drawPerspective(
  lap: PerspectiveLap, sample: PerspectiveSample, camera: PerspectiveCamera,
  road: PerspectiveRoad, reference?: PerspectiveLap | null, highlight?: Point[] | null,
): PerspectiveDrawing {
  const projector = createPerspectiveProjector(camera), ahead = clamp(280 / camera.zoom, 190, 340);
  const study = svgPath(localLine(lap, sample, ahead).map(p => projector.project([p.x, p.z])));
  let referencePath = '', roadPath = '', edges = '', highlightPath = '';
  if (reference?.points.length) {
    const first = lap.points[0], last = lap.points[lap.points.length - 1], rf = reference.points[0], rl = reference.points[reference.points.length - 1];
    const progress = (sample.dist - first.dist) / (last.dist - first.dist || 1);
    let nearest: PerspectiveSample | null = null, best = Infinity;
    for (const p of nearby(reference.spatial, sample.x, sample.z)) {
      if (Math.abs((p.dist - rf.dist) / (rl.dist - rf.dist || 1) - progress) > .075) continue;
      const d = Math.hypot(p.x - sample.x, p.z - sample.z);
      if (d < best) { best = d; nearest = p; }
    }
    if (nearest && best <= 50) referencePath = svgPath(localLine(reference, nearest, ahead).map(p => projector.project([p.x, p.z])));
  }
  let nearestRoad: RoadCross | undefined, roadDistance = Infinity;
  for (const p of nearby(road.spatial, sample.x, sample.z)) { const d = Math.hypot(p.x - sample.x, p.z - sample.z); if (d < roadDistance) { nearestRoad = p; roadDistance = d; } }
  if (nearestRoad && roadDistance <= 35) {
    const crosses = road.points.slice(arcBound(road.points, nearestRoad.arc - 35), arcBound(road.points, nearestRoad.arc + ahead)).filter(p => p.run === nearestRoad!.run);
    for (let i = 1; i < crosses.length; i++) {
      const a = crosses[i - 1], b = crosses[i];
      const polygon = projector.polygon([a.left, b.left, b.right, a.right]);
      if (polygon.length >= 3) roadPath += svgPath(polygon, true);
    }
    edges = svgPath(crosses.map(p => projector.project(p.left))) + svgPath(crosses.map(p => projector.project(p.right)));
  }
  if (highlight?.length) {
    const chain: Array<Point | null> = []; let previous: Point | undefined;
    const step = Math.max(1, Math.ceil(highlight.length / 450));
    for (let i = 0; i < highlight.length; i += step) {
      const p = highlight[i], dx = p[0] - sample.x, dz = p[1] - sample.z, forward = dx * camera.tx + dz * camera.tz;
      if (!p.every(finite) || forward < -35 || forward > ahead || Math.hypot(dx, dz) > ahead + 35 || (previous && Math.hypot(p[0] - previous[0], p[1] - previous[1]) > 50)) chain.push(null);
      else chain.push(projector.project(p));
      previous = p;
    }
    highlightPath = svgPath(chain);
  }
  return { study, reference: referencePath, road: roadPath, edges, highlight: highlightPath, anchor: projector.anchor, ahead, hasEdges: !!roadPath };
}
