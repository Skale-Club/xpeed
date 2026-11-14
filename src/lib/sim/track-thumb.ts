// The outline of a circuit as one SVG path, to draw it small (a thumbnail): the centre line of a track layout, scaled to fit a square.
// x is to the right and z is down, the way the layout file defines them, so nothing is mirrored (the same as the big map).

export interface ThumbPath {
  /** The `d` of a path; empty when the layout has fewer than two usable points. */
  d: string;
  /** The number of points drawn (after thinning). */
  points: number;
}

/**
 * Scales the points to fit `size` x `size` with `pad` around them, keeping the shape (the longer side fills the square, the other is centred),
 * thins them to at most `maxPoints`, and writes them as a path (closed with Z when `closed`). Points that are not numbers are skipped.
 */
export function thumbPath(x: ArrayLike<number>, z: ArrayLike<number>, options: { size?: number; pad?: number; maxPoints?: number; closed?: boolean } = {}): ThumbPath {
  const { size = 100, pad = 6, maxPoints = 240, closed = false } = options;
  const all: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(x.length, z.length); i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(z[i])) all.push([x[i], z[i]]);
  }
  if (all.length < 2) return { d: '', points: 0 };
  const step = Math.max(1, Math.ceil(all.length / maxPoints));
  const points = all.filter((_, index) => index % step === 0);
  if (all.length % step !== 0 && !closed) points.push(all[all.length - 1]);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, pz] of points) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  const extent = Math.max(maxX - minX, maxZ - minZ);
  if (!(extent > 0)) return { d: '', points: 0 };
  const scale = (size - 2 * pad) / extent;
  const offsetX = pad + ((size - 2 * pad) - (maxX - minX) * scale) / 2;
  const offsetZ = pad + ((size - 2 * pad) - (maxZ - minZ) * scale) / 2;
  const d = points
    .map(([px, pz], index) => `${index === 0 ? 'M' : 'L'}${(offsetX + (px - minX) * scale).toFixed(1)} ${(offsetZ + (pz - minZ) * scale).toFixed(1)}`)
    .join(' ');
  return { d: closed ? `${d} Z` : d, points: points.length };
}
