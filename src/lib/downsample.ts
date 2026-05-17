// LTTB (Largest-Triangle-Three-Buckets) downsampling.
// Reference: Sveinn Steinarsson's MSc thesis (2013).
//
// Preserves the visual shape of a time series with far fewer points than
// uniform decimation. Used to cap session_rows at ~2000 points per session
// while keeping charts visually identical to the raw data.

export interface SamplePoint {
  x: number;             // time (seconds or unix ms)
  y: number;             // value
  payload?: unknown;     // anything else (will be returned unchanged)
}

/**
 * Downsample an array of (x, y) points to at most `threshold` points using LTTB.
 * If the input is already smaller than threshold, returns it unchanged.
 *
 * Time complexity: O(n).
 */
export function lttbDownsample<T extends SamplePoint>(
  data: T[],
  threshold: number,
): T[] {
  if (threshold >= data.length || threshold <= 2) return data;

  const sampled: T[] = [];
  // Bucket size, excluding the first and last points
  const every = (data.length - 2) / (threshold - 2);

  let a = 0;
  sampled.push(data[a]); // always include the first point

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate average of next bucket
    let avgX = 0;
    let avgY = 0;
    const avgRangeStart = Math.floor((i + 1) * every) + 1;
    let avgRangeEnd = Math.floor((i + 2) * every) + 1;
    avgRangeEnd = avgRangeEnd < data.length ? avgRangeEnd : data.length;

    const avgRangeLength = avgRangeEnd - avgRangeStart;
    for (let k = avgRangeStart; k < avgRangeEnd; k++) {
      avgX += data[k].x;
      avgY += data[k].y;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    // Get the range for this bucket
    const rangeOffs = Math.floor((i + 0) * every) + 1;
    const rangeTo = Math.floor((i + 1) * every) + 1;

    const pointAX = data[a].x;
    const pointAY = data[a].y;

    let maxArea = -1;
    let nextA = rangeOffs;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (data[j].y - pointAY) -
        (pointAX - data[j].x) * (avgY - pointAY)
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }

    sampled.push(data[nextA]);
    a = nextA;
  }

  sampled.push(data[data.length - 1]); // always include the last point
  return sampled;
}

/**
 * Downsample multi-parameter rows by applying LTTB independently per parameter
 * and then merging back by time index. This keeps the parameter most prone to
 * sharp transitions in its accurate form for each merged row.
 *
 * For simplicity, the current implementation downsamples uniformly by index
 * (treating row order as the "x" axis) and applies LTTB to the *most variable*
 * numeric column. This is a pragmatic compromise vs per-parameter LTTB which
 * would produce different x-domains per series and is harder to render.
 */
export function downsampleSessionRows<R extends { t_seconds: number | null; data: Record<string, unknown> }>(
  rows: R[],
  threshold: number = 2000,
): R[] {
  if (rows.length <= threshold) return rows;

  // Pick the column with the highest variance as the LTTB driver.
  const numericKeys = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    for (const [k, v] of Object.entries(row.data)) {
      if (typeof v === 'number') numericKeys.add(k);
    }
  }
  let driverKey: string | null = null;
  let bestVar = -1;
  for (const k of numericKeys) {
    const vals: number[] = [];
    for (const r of rows) {
      const v = r.data[k];
      if (typeof v === 'number') vals.push(v);
    }
    if (vals.length < 10) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    if (variance > bestVar) {
      bestVar = variance;
      driverKey = k;
    }
  }

  // Build point array
  const points: (SamplePoint & { rowIndex: number })[] = rows.map((r, i) => ({
    x: r.t_seconds ?? i,
    y: driverKey ? (typeof r.data[driverKey] === 'number' ? (r.data[driverKey] as number) : 0) : 0,
    rowIndex: i,
  }));

  const sampled = lttbDownsample(points, threshold);
  return sampled.map(p => rows[p.rowIndex]);
}
