import { REQUIRED_CHANNELS, standardUnit } from '@/lib/sim/channels';

/**
 * The lap file: one lap of one car, every channel sampled at the same moments.
 * The Windows collector writes it, the app reads it; the byte layout is the
 * contract (docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md).
 *
 * Uncompressed layout, all numbers little-endian:
 *
 *    0   4 bytes   magic "XLAP"
 *    4   u16       format version (1)
 *    6   u16       flags (0 in version 1)
 *    8   u32       header length in bytes, a multiple of 4
 *   12   N bytes   header: UTF-8 JSON, padded with spaces to N
 *   12+N           one column per channel, in the header's order,
 *                  each sampleCount float32 values
 *
 * The file on the wire is that, gzip-compressed. Files come from outside, so
 * every length is checked against the limits below before anything is allocated.
 */

export const LAP_MAGIC = 'XLAP';
export const LAP_VERSION = 1;
const PREAMBLE_BYTES = 12;

export const LAP_LIMITS = {
  /** The JSON header. */
  headerBytes: 64 * 1024,
  /** About 2 hours of a lap at 60 Hz: far more than any real lap. */
  samples: 500_000,
  channels: 128,
  /** The file once unzipped; a larger one is refused while it is being unzipped. */
  unpackedBytes: 64 * 1024 * 1024,
} as const;

const CHANNEL_ID = /^[a-z][a-z0-9_]{0,31}$/;
const GAME_ID = /^[a-z][a-z0-9_]{0,31}$/;

export class LapFormatError extends Error {
  constructor(public readonly code: LapFormatCode, message: string) {
    super(message);
    this.name = 'LapFormatError';
  }
}

export type LapFormatCode =
  | 'bad_magic' | 'bad_version' | 'bad_flags' | 'bad_length' | 'bad_header' | 'bad_channels'
  | 'bad_data' | 'too_large' | 'bad_gzip' | 'unsupported';

export interface LapChannelInfo { id: string; unit: string }

export interface LapHeader {
  /** Lowercase id of the game the lap was driven in ("lmu", "acc"...). */
  game: string;
  track: { name: string; variant?: string; lengthM?: number };
  car: { name: string; class?: string };
  lap: {
    number: number;
    timeMs: number;
    /** False when the game voided the lap (cut track, pit lap...). */
    valid: boolean;
    sectorsMs?: number[];
  };
  /** When the lap started, ISO 8601 in UTC. */
  startedAt: string;
  /** How often the collector sampled, in Hz. Informational: `t` is the truth. */
  sampleRateHz: number;
  sampleCount: number;
  channels: LapChannelInfo[];
}

export interface LapFile {
  header: LapHeader;
  /** One column per channel id, each of `header.sampleCount` values; NaN marks a sample the game did not give. */
  data: Record<string, Float32Array>;
}

// The columns are copied as raw bytes, which is little-endian only on a little-endian machine. All browsers
// and the Node versions we run on are; this makes a surprise loud instead of silently wrong.
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max;
function fail(code: LapFormatCode, message: string): never {
  throw new LapFormatError(code, message);
}

/** Checks an untrusted header (parsed JSON) and returns it typed, or throws a LapFormatError. */
export function parseHeader(input: unknown): LapHeader {
  if (!isRecord(input)) return fail('bad_header', 'The header is not an object.');
  const { game, track, car, lap, startedAt, sampleRateHz, sampleCount, channels } = input;

  if (typeof game !== 'string' || !GAME_ID.test(game)) fail('bad_header', 'game must be a lowercase id.');
  if (!isRecord(track) || !isText(track.name, 120)) return fail('bad_header', 'track.name is missing or too long.');
  if (track.variant !== undefined && !isText(track.variant, 120)) fail('bad_header', 'track.variant is too long.');
  if (track.lengthM !== undefined && !(typeof track.lengthM === 'number' && Number.isFinite(track.lengthM) && track.lengthM > 0 && track.lengthM <= 100_000)) fail('bad_header', 'track.lengthM must be 0 to 100000.');
  if (!isRecord(car) || !isText(car.name, 120)) return fail('bad_header', 'car.name is missing or too long.');
  if (car.class !== undefined && !isText(car.class, 60)) fail('bad_header', 'car.class is too long.');

  if (!isRecord(lap)) return fail('bad_header', 'lap is missing.');
  if (!isInt(lap.number, 0, 100_000)) fail('bad_header', 'lap.number must be a whole number.');
  if (!isInt(lap.timeMs, 0, 86_400_000)) fail('bad_header', 'lap.timeMs must be milliseconds, up to 24 hours.');
  if (typeof lap.valid !== 'boolean') fail('bad_header', 'lap.valid must be true or false.');
  if (lap.sectorsMs !== undefined && !(Array.isArray(lap.sectorsMs) && lap.sectorsMs.length <= 8 && lap.sectorsMs.every((ms) => isInt(ms, 0, 86_400_000)))) fail('bad_header', 'lap.sectorsMs must be up to 8 whole milliseconds.');

  if (typeof startedAt !== 'string' || startedAt.length > 40 || Number.isNaN(Date.parse(startedAt))) fail('bad_header', 'startedAt must be an ISO 8601 date.');
  if (!(typeof sampleRateHz === 'number' && Number.isFinite(sampleRateHz) && sampleRateHz > 0 && sampleRateHz <= 1000)) fail('bad_header', 'sampleRateHz must be above 0 and at most 1000.');
  if (!isInt(sampleCount, 1, LAP_LIMITS.samples)) fail('bad_header', `sampleCount must be 1 to ${LAP_LIMITS.samples}.`);

  if (!Array.isArray(channels) || channels.length < REQUIRED_CHANNELS.length || channels.length > LAP_LIMITS.channels) {
    return fail('bad_channels', `A lap has ${REQUIRED_CHANNELS.length} to ${LAP_LIMITS.channels} channels.`);
  }
  const seen = new Set<string>();
  const parsedChannels: LapChannelInfo[] = channels.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !CHANNEL_ID.test(entry.id)) return fail('bad_channels', 'A channel id must be lowercase letters, digits and underscores.');
    if (typeof entry.unit !== 'string' || entry.unit.length < 1 || entry.unit.length > 16) return fail('bad_channels', `Channel ${entry.id} needs a unit.`);
    if (seen.has(entry.id)) return fail('bad_channels', `Channel ${entry.id} is listed twice.`);
    seen.add(entry.id);
    const standard = standardUnit(entry.id);
    if (standard !== null && standard !== entry.unit) return fail('bad_channels', `Channel ${entry.id} must be in ${standard}, not ${entry.unit}.`);
    return { id: entry.id, unit: entry.unit };
  });
  for (const required of REQUIRED_CHANNELS) if (!seen.has(required)) fail('bad_channels', `Channel ${required} is required.`);

  return {
    game: game as string,
    track: { name: track.name as string, ...(track.variant !== undefined ? { variant: track.variant as string } : {}), ...(track.lengthM !== undefined ? { lengthM: track.lengthM as number } : {}) },
    car: { name: car.name as string, ...(car.class !== undefined ? { class: car.class as string } : {}) },
    lap: {
      number: lap.number as number, timeMs: lap.timeMs as number, valid: lap.valid as boolean,
      ...(lap.sectorsMs !== undefined ? { sectorsMs: lap.sectorsMs as number[] } : {}),
    },
    startedAt: startedAt as string,
    sampleRateHz: sampleRateHz as number,
    sampleCount: sampleCount as number,
    channels: parsedChannels,
  };
}

/** The header as JSON text with the keys in the one fixed order writers use, so equal laps give equal bytes. */
function serializeHeader(header: LapHeader): string {
  return JSON.stringify({
    game: header.game,
    track: { name: header.track.name, variant: header.track.variant, lengthM: header.track.lengthM },
    car: { name: header.car.name, class: header.car.class },
    lap: { number: header.lap.number, timeMs: header.lap.timeMs, valid: header.lap.valid, sectorsMs: header.lap.sectorsMs },
    startedAt: header.startedAt,
    sampleRateHz: header.sampleRateHz,
    sampleCount: header.sampleCount,
    channels: header.channels.map((channel) => ({ id: channel.id, unit: channel.unit })),
  });
}

/** Lays a lap out as bytes (not yet compressed). Throws a LapFormatError if the lap is not valid. */
export function packLap(file: LapFile): Uint8Array {
  if (!HOST_IS_LITTLE_ENDIAN) return fail('unsupported', 'Lap files need a little-endian machine.');
  const header = parseHeader(JSON.parse(serializeHeader(file.header)));
  for (const { id } of header.channels) {
    const column = file.data[id];
    if (!(column instanceof Float32Array) || column.length !== header.sampleCount) return fail('bad_data', `Channel ${id} must hold ${header.sampleCount} float32 values.`);
  }

  const text = new TextEncoder().encode(serializeHeader(header));
  const headerBytes = Math.ceil(text.length / 4) * 4;
  if (headerBytes > LAP_LIMITS.headerBytes) return fail('bad_header', 'The header is too large.');
  const columnBytes = header.sampleCount * 4;
  const out = new Uint8Array(PREAMBLE_BYTES + headerBytes + header.channels.length * columnBytes);
  if (out.length > LAP_LIMITS.unpackedBytes) return fail('too_large', 'The lap is too large.');

  out.set(new TextEncoder().encode(LAP_MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, LAP_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, headerBytes, true);
  out.set(text, PREAMBLE_BYTES);
  out.fill(0x20, PREAMBLE_BYTES + text.length, PREAMBLE_BYTES + headerBytes);

  let offset = PREAMBLE_BYTES + headerBytes;
  for (const { id } of header.channels) {
    out.set(new Uint8Array(file.data[id].buffer, file.data[id].byteOffset, columnBytes), offset);
    offset += columnBytes;
  }
  return out;
}

/** Reads bytes laid out by `packLap` (or by the collector). Throws a LapFormatError on anything that is not a well-formed lap. */
export function unpackLap(bytes: Uint8Array): LapFile {
  if (!HOST_IS_LITTLE_ENDIAN) return fail('unsupported', 'Lap files need a little-endian machine.');
  if (bytes.length < PREAMBLE_BYTES) return fail('bad_length', 'The file is too short.');
  if (bytes.length > LAP_LIMITS.unpackedBytes) return fail('too_large', 'The file is too large.');
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== LAP_MAGIC) return fail('bad_magic', 'Not a lap file.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== LAP_VERSION) return fail('bad_version', `Unsupported lap file version ${view.getUint16(4, true)}.`);
  if (view.getUint16(6, true) !== 0) return fail('bad_flags', 'Unknown flags.');
  const headerBytes = view.getUint32(8, true);
  if (headerBytes === 0 || headerBytes % 4 !== 0 || headerBytes > LAP_LIMITS.headerBytes || PREAMBLE_BYTES + headerBytes > bytes.length) {
    return fail('bad_length', 'The header length is not valid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerBytes)));
  } catch {
    return fail('bad_header', 'The header is not valid JSON.');
  }
  const header = parseHeader(parsed);

  const columnBytes = header.sampleCount * 4;
  if (bytes.length !== PREAMBLE_BYTES + headerBytes + header.channels.length * columnBytes) {
    return fail('bad_length', 'The file size does not match its header.');
  }

  const data: Record<string, Float32Array> = {};
  let offset = PREAMBLE_BYTES + headerBytes;
  for (const { id } of header.channels) {
    // A copy, so the column is aligned whatever the offset of `bytes` inside its buffer.
    const column = new Float32Array(header.sampleCount);
    new Uint8Array(column.buffer).set(bytes.subarray(offset, offset + columnBytes));
    data[id] = column;
    offset += columnBytes;
  }
  return { header, data };
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
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

const streamOf = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

/** The file as it is sent and stored: the lap's bytes, gzip-compressed. */
export async function gzipLap(file: LapFile): Promise<Uint8Array> {
  return readAll(streamOf(packLap(file)).pipeThrough(new CompressionStream('gzip')), LAP_LIMITS.unpackedBytes);
}

/**
 * Reads a lap from what was sent or stored. `maxBytes` caps the unzipped size, so a small file that
 * unzips to gigabytes is stopped while it is being read.
 */
export async function gunzipLap(bytes: Uint8Array, options: { maxBytes?: number } = {}): Promise<LapFile> {
  const maxBytes = Math.min(options.maxBytes ?? LAP_LIMITS.unpackedBytes, LAP_LIMITS.unpackedBytes);
  let unpacked: Uint8Array;
  try {
    unpacked = await readAll(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')), maxBytes);
  } catch (error) {
    if (error instanceof LapFormatError) throw error;
    return fail('bad_gzip', 'The file is not valid gzip data.');
  }
  return unpackLap(unpacked);
}
