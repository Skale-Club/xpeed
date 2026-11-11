/**
 * How far a lap was from the game's ideal line, along the lap: the sideways distance from each point of the lap to the
 * nearest point of the ideal line, positive to the driver's LEFT of it (the same left as the track file's edges).
 * This is what tells "the line the track has" from "the line the driver took", and where taking another line cost time.
 */

export interface IdealLine {
  x: ArrayLike<number>;
  z: ArrayLike<number>;
  closed: boolean;
}

/** How many segments either side of the last match are searched before falling back to the whole line. */
const WINDOW = 120;
/** Further than this from the line, the local match is not trusted and the whole line is searched. */
const LOST_M = 60;

interface Match {
  segment: number;
  offset: number;
  distance: number;
}

function matchOnSegment(line: IdealLine, segment: number, px: number, pz: number): Match {
  const n = line.x.length;
  const a = segment;
  const b = (segment + 1) % n;
  const ax = line.x[a], az = line.z[a];
  const tx = line.x[b] - ax, tz = line.z[b] - az;
  const lengthSq = tx * tx + tz * tz;
  const along = lengthSq > 0 ? Math.min(1, Math.max(0, ((px - ax) * tx + (pz - az) * tz) / lengthSq)) : 0;
  const qx = ax + along * tx, qz = az + along * tz;
  const dx = px - qx, dz = pz - qz;
  const distance = Math.hypot(dx, dz);
  const length = Math.sqrt(lengthSq) || 1;
  // Left of the direction of travel: (t.z, -t.x), as in the track file.
  const side = (dx * tz - dz * tx) / length;
  return { segment, offset: side >= 0 ? distance : -distance, distance };
}

function best(line: IdealLine, from: number, to: number, px: number, pz: number): Match {
  const n = line.x.length;
  const segments = line.closed ? n : n - 1;
  let found: Match | null = null;
  for (let s = from; s <= to; s++) {
    const segment = ((s % segments) + segments) % segments;
    const match = matchOnSegment(line, segment, px, pz);
    if (!found || match.distance < found.distance) found = match;
  }
  return found!;
}

/**
 * The signed offset (metres, + = left of the ideal line) of each point. Points that are not numbers give NaN. The search
 * follows the lap along the line (a lap goes round in order), so a part of the track that passes close to another part
 * (a crossover, a hairpin) is not mistaken for it.
 */
export function offsetsFromLine(line: IdealLine, xs: ArrayLike<number>, zs: ArrayLike<number>): number[] {
  const n = line.x.length;
  const segments = line.closed ? n : n - 1;
  const out: number[] = [];
  let last: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    const px = xs[i], pz = zs[i];
    if (!Number.isFinite(px) || !Number.isFinite(pz) || segments < 1) {
      out.push(Number.NaN);
      continue;
    }
    let match: Match = last === null || segments <= 2 * WINDOW ? best(line, 0, segments - 1, px, pz) : best(line, last - WINDOW, last + WINDOW, px, pz);
    if (match.distance > LOST_M) match = best(line, 0, segments - 1, px, pz);
    last = match.segment;
    out.push(match.offset);
  }
  return out;
}

export interface OffLineStretch {
  fromM: number;
  toM: number;
  /** The largest offset in the stretch, signed (+ = left). */
  maxM: number;
  side: 'left' | 'right';
  /** What the lap lost (+) or gained (-) against the reference over the stretch, when there is one. */
  seconds: number | null;
}

/**
 * The stretches where the lap kept away from the ideal line: at least `minOffsetM` to the same side for at least
 * `minLengthM`. With a gap to a reference, the ones that cost the most time come first; without, the furthest off.
 */
export function offLineStretches(
  grid: number[],
  offsets: number[],
  gap: number[] | null,
  options: { minOffsetM?: number; minLengthM?: number; count?: number } = {},
): OffLineStretch[] {
  const { minOffsetM = 1.5, minLengthM = 30, count = 5 } = options;
  const found: OffLineStretch[] = [];
  let start = -1;
  let sign = 0;
  let peak = 0;
  const close = (end: number) => {
    if (start < 0) return;
    const fromM = grid[start];
    const toM = grid[end];
    if (toM - fromM >= minLengthM) {
      const before = gap?.[start];
      const after = gap?.[end];
      const seconds = gap && Number.isFinite(before) && Number.isFinite(after) ? (after as number) - (before as number) : null;
      found.push({ fromM, toM, maxM: peak, side: sign > 0 ? 'left' : 'right', seconds });
    }
    start = -1;
    sign = 0;
    peak = 0;
  };
  for (let i = 0; i < grid.length; i++) {
    const o = offsets[i];
    const s = Number.isFinite(o) && Math.abs(o) >= minOffsetM ? Math.sign(o) : 0;
    if (s !== sign) close(i - 1 >= 0 ? i - 1 : 0);
    if (s !== 0) {
      if (start < 0) {
        start = i;
        sign = s;
      }
      if (Math.abs(o) > Math.abs(peak)) peak = o;
    }
  }
  close(grid.length - 1);
  const anyTime = found.some((stretch) => stretch.seconds !== null);
  found.sort((a, b) => (anyTime ? (b.seconds ?? -Infinity) - (a.seconds ?? -Infinity) : Math.abs(b.maxM) - Math.abs(a.maxM)));
  return found.slice(0, count);
}
