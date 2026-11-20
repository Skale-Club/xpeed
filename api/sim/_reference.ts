// The reference trace GET /api/sim/reference answers with: the time (ms) a lap had reached at every STEP_M metres of distance.
// Pure, so it is tested on its own.

/** The distance between two points of a reference trace, in metres. */
export const STEP_M = 5;

/**
 * The lap's time in whole milliseconds at 0 m, 5 m, 10 m ... up to the last metre it covers, by linear interpolation between the
 * samples. A sample is used only when its `t` and `dist` are real numbers and both are not behind the last sample used: a sample whose
 * distance goes backwards (or stands still) or whose time goes backwards is ignored, so the trace is always increasing. Where the lap
 * starts past 0 m the first points are the time of its first sample. Empty when fewer than two samples can be used.
 */
export function referencePoints(t: ArrayLike<number>, dist: ArrayLike<number>, stepM: number = STEP_M): number[] {
  const n = Math.min(t.length, dist.length);
  const ds: number[] = [];
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = dist[i], s = t[i];
    if (!Number.isFinite(d) || !Number.isFinite(s) || d < 0 || s < 0) continue;
    if (ds.length > 0 && (d <= ds[ds.length - 1] || s < ts[ts.length - 1])) continue;
    ds.push(d);
    ts.push(s);
  }
  if (ds.length < 2) return [];
  const last = ds[ds.length - 1];
  const points: number[] = [];
  let j = 0; // the segment [ds[j], ds[j + 1]] that holds the metre being asked for
  for (let metre = 0; metre <= last; metre += stepM) {
    while (j < ds.length - 2 && ds[j + 1] < metre) j++;
    const span = ds[j + 1] - ds[j];
    const at = metre <= ds[j] ? ts[j] : ts[j] + ((metre - ds[j]) / span) * (ts[j + 1] - ts[j]);
    points.push(Math.round(at * 1000));
  }
  return points;
}
