/**
 * The track layout file (.xtrk, version 1): the real shape of a circuit as Xpeed Sim reads it from a game's own files.
 * Spec: docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md (that page is the contract; this is a strict reader of it).
 *
 * A layout is the centre line of the track, how far each edge is on either side, the game's ideal line and the pit lane;
 * the line a car actually drove (a lap file) is drawn over it. Files come from outside, so every size is checked before
 * anything is allocated, and a file that is not exactly what the spec describes is refused with a code.
 */

export const TRACK_MAGIC = 'XTRK';
export const TRACK_VERSION = 1;

export const TRACK_LIMITS = {
  headerBytes: 65_536,
  minPoints: 2,
  maxPoints: 200_000,
  /** Widest a side of the road may be. */
  maxSideM: 200,
  /** A closed track's ends may be this far apart (the closing stretch is not in the data). */
  maxClosingGapM: 50,
  /** What a file may weigh once unzipped; a small file that unzips to more is stopped while it is read. */
  unpackedBytes: 64 * 1024 * 1024,
} as const;

export type TrackFormatCode =
  | 'bad_magic' | 'bad_version' | 'bad_flags' | 'bad_length' | 'bad_header' | 'bad_section' | 'bad_data' | 'too_large' | 'bad_gzip';

export class TrackFormatError extends Error {
  constructor(readonly code: TrackFormatCode, message: string) {
    super(message);
    this.name = 'TrackFormatError';
  }
}

function fail(code: TrackFormatCode, message: string): never {
  throw new TrackFormatError(code, message);
}

export interface TrackHeader {
  /** `ac`, `sce`... */
  game: string;
  track: { name: string; variant?: string; title?: string; lengthM?: number };
  source: string;
  frame: string;
  closed: boolean;
  centerKind: 'edges_midpoint' | 'game_line';
}

export interface CenterLine {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  dist: Float32Array;
  /** Metres from the centre line to the left edge (the driver's left); NaN where unknown (and then `right` is NaN too). */
  left: Float32Array;
  right: Float32Array;
}

export interface TrackFile {
  header: TrackHeader;
  centerline: CenterLine;
  /** The game's ideal line, point for point with the centre line. */
  fast?: { x: Float32Array; z: Float32Array };
  pitlane?: { x: Float32Array; z: Float32Array; left: Float32Array; right: Float32Array };
}

const SECTION_CHANNELS = {
  centerline: ['x', 'y', 'z', 'dist', 'left', 'right'],
  fast: ['x', 'z'],
  pitlane: ['x', 'z', 'left', 'right'],
} as const;
type SectionId = keyof typeof SECTION_CHANNELS;
const SECTION_ORDER: readonly SectionId[] = ['centerline', 'fast', 'pitlane'];

const PREAMBLE_BYTES = 12;
const GAME_ID = /^[a-z][a-z0-9_]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max && ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= TRACK_LIMITS.minPoints && value <= TRACK_LIMITS.maxPoints;

interface SectionInfo {
  id: SectionId;
  count: number;
}

/** Checks an untrusted header (parsed JSON) and returns it typed, with the sections it lists. */
export function parseTrackHeader(input: unknown): { header: TrackHeader; sections: SectionInfo[] } {
  if (!isRecord(input)) return fail('bad_header', 'The header must be a JSON object.');
  const { game, track, source, frame, closed, centerKind, sections } = input;
  if (typeof game !== 'string' || !GAME_ID.test(game)) fail('bad_header', 'game must be a lowercase id.');
  if (!isRecord(track) || !isText(track.name, 120)) return fail('bad_header', 'track.name must be 1 to 120 characters.');
  for (const key of ['variant', 'title'] as const) {
    if (track[key] !== undefined && !isText(track[key], 120)) fail('bad_header', `track.${key} must be 1 to 120 characters.`);
  }
  const lengthM = track.lengthM;
  if (lengthM !== undefined && !(typeof lengthM === 'number' && Number.isFinite(lengthM) && lengthM > 0 && lengthM <= 100_000)) {
    fail('bad_header', 'track.lengthM must be above 0 and at most 100000.');
  }
  if (!isText(source, 64)) fail('bad_header', 'source must be 1 to 64 characters.');
  if (!isText(frame, 200)) fail('bad_header', 'frame must be 1 to 200 characters.');
  if (typeof closed !== 'boolean') fail('bad_header', 'closed must be true or false.');
  if (centerKind !== 'edges_midpoint' && centerKind !== 'game_line') fail('bad_header', 'centerKind is not one the spec knows.');
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 3) return fail('bad_section', 'There must be 1 to 3 sections.');

  const found: SectionInfo[] = [];
  let lastOrder = -1;
  for (const entry of sections) {
    if (!isRecord(entry) || typeof entry.id !== 'string') return fail('bad_section', 'A section needs an id.');
    const order = SECTION_ORDER.indexOf(entry.id as SectionId);
    if (order < 0) return fail('bad_section', `Unknown section "${entry.id}".`);
    if (order <= lastOrder) return fail('bad_section', 'Sections come once each, in the order centerline, fast, pitlane.');
    lastOrder = order;
    const id = entry.id as SectionId;
    const wanted = SECTION_CHANNELS[id];
    if (!Array.isArray(entry.channels) || entry.channels.length !== wanted.length || entry.channels.some((c, i) => c !== wanted[i])) {
      return fail('bad_section', `The channels of ${id} must be exactly ${wanted.join(', ')}.`);
    }
    if (!isCount(entry.count)) return fail('bad_section', `The count of ${id} must be a whole number from 2 to 200000.`);
    found.push({ id, count: entry.count });
  }
  if (found[0].id !== 'centerline') fail('bad_section', 'The centerline section is required, and first.');
  const fast = found.find((s) => s.id === 'fast');
  if (fast && fast.count !== found[0].count) fail('bad_section', 'The fast line must have as many points as the centre line.');

  const header: TrackHeader = {
    game,
    track: {
      name: track.name,
      ...(track.variant !== undefined ? { variant: track.variant as string } : {}),
      ...(track.title !== undefined ? { title: track.title as string } : {}),
      ...(lengthM !== undefined ? { lengthM } : {}),
    },
    source,
    frame,
    closed,
    centerKind,
  };
  return { header, sections: found };
}

/** Both NaN, or both a width between 0 (exclusive) and the limit. */
function checkWidths(left: Float32Array, right: Float32Array, what: string): void {
  for (let i = 0; i < left.length; i++) {
    const [a, b] = [left[i], right[i]];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    const ok = (v: number) => v > 0 && v <= TRACK_LIMITS.maxSideM;
    if (!(ok(a) && ok(b))) fail('bad_data', `${what}: the widths of point ${i} are not both unknown or both between 0 and ${TRACK_LIMITS.maxSideM} m.`);
  }
}

function allFinite(values: Float32Array, what: string): void {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) fail('bad_data', `${what} has a value that is not a number (point ${i}).`);
}

/** Reads a track layout from its unzipped bytes. Throws a TrackFormatError on anything that is not exactly the spec. */
export function unpackTrack(bytes: Uint8Array): TrackFile {
  if (bytes.length < PREAMBLE_BYTES) return fail('bad_length', 'The file is too short to be a track layout.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== TRACK_MAGIC) return fail('bad_magic', 'This is not a track layout file.');
  if (view.getUint16(4, true) !== TRACK_VERSION) return fail('bad_version', 'This track layout is of a version this reader does not know.');
  if (view.getUint16(6, true) !== 0) return fail('bad_flags', 'This track layout uses flags this reader does not know.');
  const headerBytes = view.getUint32(8, true);
  if (headerBytes < 4 || headerBytes > TRACK_LIMITS.headerBytes || headerBytes % 4 !== 0 || PREAMBLE_BYTES + headerBytes > bytes.length) {
    return fail('bad_length', 'The header size is not valid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerBytes)));
  } catch {
    return fail('bad_header', 'The header is not valid JSON.');
  }
  const { header, sections } = parseTrackHeader(parsed);

  const columns = sections.reduce((total, s) => total + SECTION_CHANNELS[s.id].length * s.count, 0);
  if (bytes.length !== PREAMBLE_BYTES + headerBytes + columns * 4) return fail('bad_length', 'The file size does not match its header.');

  let offset = PREAMBLE_BYTES + headerBytes;
  const read = (count: number): Float32Array => {
    // A copy, so the column is aligned whatever the offset of `bytes` inside its buffer.
    const column = new Float32Array(count);
    new Uint8Array(column.buffer).set(bytes.subarray(offset, offset + count * 4));
    offset += count * 4;
    return column;
  };
  const sectionData: Record<string, Record<string, Float32Array>> = {};
  for (const { id, count } of sections) {
    sectionData[id] = Object.fromEntries(SECTION_CHANNELS[id].map((channel) => [channel, read(count)]));
  }

  const c = sectionData.centerline as unknown as CenterLine;
  for (const channel of ['x', 'y', 'z', 'dist'] as const) allFinite(c[channel], `centerline.${channel}`);
  for (let i = 0; i < c.dist.length; i++) {
    if (c.dist[i] < 0 || (i > 0 && c.dist[i] < c.dist[i - 1])) fail('bad_data', `centerline.dist goes backwards or below zero at point ${i}.`);
  }
  checkWidths(c.left, c.right, 'centerline');
  if (header.closed) {
    const last = c.x.length - 1;
    if (Math.hypot(c.x[0] - c.x[last], c.z[0] - c.z[last]) > TRACK_LIMITS.maxClosingGapM) {
      fail('bad_data', `The ends of a closed track must be at most ${TRACK_LIMITS.maxClosingGapM} m apart.`);
    }
  }
  const fast = sectionData.fast as unknown as TrackFile['fast'];
  if (fast) for (const channel of ['x', 'z'] as const) allFinite(fast[channel], `fast.${channel}`);
  const pit = sectionData.pitlane as unknown as TrackFile['pitlane'];
  if (pit) {
    for (const channel of ['x', 'z'] as const) allFinite(pit[channel], `pitlane.${channel}`);
    checkWidths(pit.left, pit.right, 'pitlane');
  }
  return { header, centerline: c, ...(fast ? { fast } : {}), ...(pit ? { pitlane: pit } : {}) };
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return fail('too_large', 'The file is too large once unzipped.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const streamOf = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

/** Reads a track layout as it is stored (gzip). The unzipped size is capped while it is read. */
export async function gunzipTrack(bytes: Uint8Array, options: { maxBytes?: number } = {}): Promise<TrackFile> {
  let unpacked: Uint8Array;
  try {
    unpacked = await readAll(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')), Math.min(options.maxBytes ?? TRACK_LIMITS.unpackedBytes, TRACK_LIMITS.unpackedBytes));
  } catch (error) {
    if (error instanceof TrackFormatError) throw error;
    return fail('bad_gzip', 'The file is not valid gzip data.');
  }
  return unpackTrack(unpacked);
}

/** What a track layout is matched by: the game, the track and the layout, the way a lap file names them. */
export const trackKeyOf = (game: string, name: string, variant?: string | null) =>
  [game, name, variant ?? ''].map((part) => part.trim().toLowerCase()).join('|');

export const trackKey = (track: TrackFile) => trackKeyOf(track.header.game, track.header.track.name, track.header.track.variant);

export type Point = [x: number, z: number];

/** The unit vector to the driver's LEFT at each point (spec: tangent from the neighbours, then `(t.z, -t.x)`). */
export function leftNormals(x: ArrayLike<number>, z: ArrayLike<number>, closed: boolean): Point[] {
  const n = x.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = closed ? [(i + n - 1) % n, (i + 1) % n] : [Math.max(i - 1, 0), Math.min(i + 1, n - 1)];
    let tx = x[b] - x[a];
    let tz = z[b] - z[a];
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    out.push([tz, -tx]);
  }
  return out;
}

export interface RoadRun {
  left: Point[];
  right: Point[];
}

/**
 * The road as runs of consecutive points whose widths are known, with the edge of each: the centre line moved to the left
 * by `left` and to the right by `right` along the normal. A closed track whose every width is known gives one run that
 * closes on itself.
 */
export function roadRuns(track: TrackFile): { runs: RoadRun[]; closedRing: boolean } {
  const { x, z, left, right } = track.centerline;
  return bandRuns(x, z, left, right, track.header.closed);
}

/** The same for any line with widths (the pit lane is one: open, and usually without widths). */
export function bandRuns(
  x: ArrayLike<number>, z: ArrayLike<number>, left: ArrayLike<number>, right: ArrayLike<number>, closed: boolean,
): { runs: RoadRun[]; closedRing: boolean } {
  const normals = leftNormals(x, z, closed);
  const runs: RoadRun[] = [];
  let current: RoadRun | null = null;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(left[i])) {
      current = null;
      continue;
    }
    if (!current) {
      current = { left: [], right: [] };
      runs.push(current);
    }
    const [lx, lz] = normals[i];
    current.left.push([x[i] + left[i] * lx, z[i] + left[i] * lz]);
    current.right.push([x[i] - right[i] * lx, z[i] - right[i] * lz]);
  }
  const closedRing = closed && runs.length === 1 && runs[0].left.length === x.length;
  return { runs, closedRing };
}
