import type { TrackFile } from '@/lib/sim/track-file';

/** Track layouts for tests: built here, and written byte by byte as the spec says (the real writer is in Xpeed Companion). */

export interface LayoutSpec {
  game?: string;
  name?: string;
  variant?: string;
  closed?: boolean;
  /** Centre line positions. */
  points: Array<[x: number, z: number]>;
  /** Metres to each edge; NaN or left out = unknown. */
  width?: number;
  ideal?: boolean;
  /** How far the ideal line is moved from the centre line, in x and in z (default 1.5 m). */
  idealShift?: number;
  pit?: Array<[x: number, z: number]>;
}

const f32 = (values: ArrayLike<number>) => Float32Array.from(values as ArrayLike<number>);

export function makeLayout(spec: LayoutSpec): TrackFile {
  const n = spec.points.length;
  const x = f32(spec.points.map((p) => p[0]));
  const z = f32(spec.points.map((p) => p[1]));
  const dist = new Float32Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  const side = new Float32Array(n).fill(spec.width ?? Number.NaN);
  return {
    header: {
      game: spec.game ?? 'ac',
      track: { name: spec.name ?? 'Test Track', ...(spec.variant !== undefined ? { variant: spec.variant } : {}) },
      source: 'fast_lane.ai',
      frame: 'game world metres, x and z horizontal, y up',
      closed: spec.closed ?? false,
      centerKind: 'edges_midpoint',
    },
    centerline: { x, y: new Float32Array(n), z, dist, left: side, right: side.slice() },
    ...(spec.ideal ? { fast: { x: x.map((v) => v + (spec.idealShift ?? 1.5)), z: z.map((v) => v + (spec.idealShift ?? 1.5)) } } : {}),
    ...(spec.pit
      ? {
          pitlane: {
            x: f32(spec.pit.map((p) => p[0])),
            z: f32(spec.pit.map((p) => p[1])),
            left: new Float32Array(spec.pit.length).fill(Number.NaN),
            right: new Float32Array(spec.pit.length).fill(Number.NaN),
          },
        }
      : {}),
  };
}

/** A circle of `radius` metres with `count` points, going round once. */
export const circle = (radius: number, count = 60): Array<[number, number]> =>
  Array.from({ length: count }, (_, i) => [radius * Math.cos((2 * Math.PI * i) / count), radius * Math.sin((2 * Math.PI * i) / count)] as [number, number]);

/** The layout as the unpacked file (before gzip), laid out the way FORMATO-DE-PISTA.md says. */
export function packLayout(track: TrackFile): Uint8Array {
  const sections = [
    { id: 'centerline', count: track.centerline.x.length, channels: ['x', 'y', 'z', 'dist', 'left', 'right'] },
    ...(track.fast ? [{ id: 'fast', count: track.fast.x.length, channels: ['x', 'z'] }] : []),
    ...(track.pitlane ? [{ id: 'pitlane', count: track.pitlane.x.length, channels: ['x', 'z', 'left', 'right'] }] : []),
  ];
  const json = JSON.stringify({ ...track.header, sections });
  const headerBytes = Math.ceil((json.length + 1) / 4) * 4;
  const header = new TextEncoder().encode(json.padEnd(headerBytes, ' '));
  const columns: Float32Array[] = [
    ...(['x', 'y', 'z', 'dist', 'left', 'right'] as const).map((k) => track.centerline[k]),
    ...(track.fast ? [track.fast.x, track.fast.z] : []),
    ...(track.pitlane ? [track.pitlane.x, track.pitlane.z, track.pitlane.left, track.pitlane.right] : []),
  ];
  const out = new Uint8Array(12 + headerBytes + columns.reduce((total, c) => total + c.length * 4, 0));
  const view = new DataView(out.buffer);
  out.set([0x58, 0x54, 0x52, 0x4b], 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, headerBytes, true);
  out.set(header, 12);
  let at = 12 + headerBytes;
  for (const column of columns) {
    for (const value of column) {
      view.setFloat32(at, value, true);
      at += 4;
    }
  }
  return out;
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }).pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
