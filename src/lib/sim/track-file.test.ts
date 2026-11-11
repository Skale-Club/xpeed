import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TRACK_LIMITS, TrackFormatError, gunzipTrack, leftNormals, parseTrackHeader, roadRuns, trackKey, trackKeyOf, unpackTrack,
  type TrackFormatCode,
} from './track-file';

/**
 * The spec's test vector (docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md), read from the page itself so the
 * reader is checked against the contract and not against a copy that can drift from it.
 */
function goldenBytes(): Uint8Array {
  const page = readFileSync('docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md', 'utf8');
  const after = page.slice(page.indexOf('Arquivo completo em hexadecimal'));
  const hex = /```\r?\n([0-9a-f]+)\r?\n```/.exec(after)?.[1];
  if (!hex) throw new Error('The golden hex block was not found in the spec.');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

const copy = (bytes: Uint8Array) => new Uint8Array(bytes);
const codeOf = (run: () => unknown): TrackFormatCode | 'no error' | string => {
  try { run(); } catch (error) { return error instanceof TrackFormatError ? error.code : `other: ${String(error)}`; }
  return 'no error';
};
const asyncCodeOf = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (error) { return error instanceof TrackFormatError ? error.code : `other: ${String(error)}`; }
  return 'no error';
};

/** Where the columns start in the golden file: 12 bytes of preamble and a 392-byte header. */
const DATA = 12 + 392;
const CENTER_X = DATA;
const CENTER_DIST = DATA + 3 * 16;
const CENTER_LEFT = DATA + 4 * 16;

const setFloat = (bytes: Uint8Array, at: number, value: number) => new DataView(bytes.buffer, bytes.byteOffset).setFloat32(at, value, true);

async function gzipped(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }).pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('the golden track', () => {
  it('has the size the spec says', () => {
    expect(goldenBytes().length).toBe(564);
  });

  it('is read as the square the spec describes', () => {
    const track = unpackTrack(goldenBytes());
    expect(track.header).toEqual({
      game: 'ac',
      track: { name: 'Test Track', variant: 'GP', lengthM: 40 },
      source: 'fast_lane.ai',
      frame: 'game world metres, x and z horizontal, y up',
      closed: true,
      centerKind: 'edges_midpoint',
    });
    const c = track.centerline;
    expect([...c.x]).toEqual([0, 10, 10, 0]);
    expect([...c.z]).toEqual([0, 0, 10, 10]);
    expect([...c.dist]).toEqual([0, 10, 20, 30]);
    expect([...c.left].slice(0, 3)).toEqual([5, 5, 5]);
    expect(Number.isNaN(c.left[3]) && Number.isNaN(c.right[3])).toBe(true);
    expect([...track.fast!.x]).toEqual([1, 9, 9, 1]);
    expect([...track.fast!.z]).toEqual([1, 1, 9, 9]);
    expect([...track.pitlane!.x]).toEqual([0, 10]);
    expect([...track.pitlane!.z]).toEqual([-8, -8]);
    expect(track.pitlane!.left.every(Number.isNaN)).toBe(true);
  });

  it('reads the same bytes whatever the alignment of the buffer they sit in', () => {
    const golden = goldenBytes();
    const shifted = new Uint8Array(golden.length + 3);
    shifted.set(golden, 3);
    expect([...unpackTrack(shifted.subarray(3)).centerline.x]).toEqual([0, 10, 10, 0]);
  });

  it('is read from gzip, as it is stored', async () => {
    const track = await gunzipTrack(await gzipped(goldenBytes()));
    expect(track.centerline.x.length).toBe(4);
  });

  it('puts the left edge of point 0 where the spec computes it', () => {
    const track = unpackTrack(goldenBytes());
    const [[lx, lz]] = leftNormals(track.centerline.x, track.centerline.z, true);
    expect(lx).toBeCloseTo(-0.7071, 3);
    expect(lz).toBeCloseTo(-0.7071, 3);
    const { runs, closedRing } = roadRuns(track);
    expect(runs[0].left[0][0]).toBeCloseTo(-3.54, 2);
    expect(runs[0].left[0][1]).toBeCloseTo(-3.54, 2);
    expect(runs[0].right[0][0]).toBeCloseTo(3.54, 2);
    // The last point has no width, so the road is one run of three points and does not close on itself.
    expect(runs).toHaveLength(1);
    expect(runs[0].left).toHaveLength(3);
    expect(closedRing).toBe(false);
  });

  it('is matched by game, track and layout, whatever the case', () => {
    expect(trackKey(unpackTrack(goldenBytes()))).toBe('ac|test track|gp');
    expect(trackKeyOf('AC', ' Test Track ', 'gp')).toBe('ac|test track|gp');
    expect(trackKeyOf('lmu', 'Monza')).toBe('lmu|monza|');
  });
});

describe('a file that is not exactly the spec', () => {
  it.each<[string, (b: Uint8Array) => void, TrackFormatCode]>([
    ['another magic', (b) => { b[0] = 0x59; }, 'bad_magic'],
    ['a newer version', (b) => { b[4] = 2; }, 'bad_version'],
    ['flags set', (b) => { b[6] = 1; }, 'bad_flags'],
    ['a header size that is not a multiple of 4', (b) => { b[8] = 0x87; }, 'bad_length'],
    ['a header that is not an object', (b) => { b[12] = 0x5b; }, 'bad_header'],
    // "fast" becomes "fasT": same length, so the file size still matches.
    ['an unknown section', (b) => { b[12 + new TextDecoder().decode(b.subarray(12, 12 + 392)).indexOf('"id":"fast"') + 9] = 0x54; }, 'bad_section'],
    ['a distance that goes backwards', (b) => setFloat(b, CENTER_DIST + 4, -1), 'bad_data'],
    ['a width known on one side only', (b) => setFloat(b, CENTER_LEFT, Number.NaN), 'bad_data'],
    ['a width above 200 m', (b) => setFloat(b, CENTER_LEFT, 201), 'bad_data'],
    ['a position that is not a number', (b) => setFloat(b, CENTER_X + 4, Number.NaN), 'bad_data'],
    ['a closed track whose ends are far apart', (b) => setFloat(b, CENTER_X + 12, 1000), 'bad_data'],
  ])('is refused with %s', (_what, mutate, code) => {
    const bytes = copy(goldenBytes());
    mutate(bytes);
    expect(codeOf(() => unpackTrack(bytes))).toBe(code);
  });

  it('is refused when it is cut short or has bytes to spare', () => {
    const golden = goldenBytes();
    expect(codeOf(() => unpackTrack(golden.subarray(0, golden.length - 4)))).toBe('bad_length');
    expect(codeOf(() => unpackTrack(new Uint8Array([...golden, 0, 0, 0, 0])))).toBe('bad_length');
    expect(codeOf(() => unpackTrack(golden.subarray(0, 8)))).toBe('bad_length');
  });

  it('is refused when it is not gzip, and when it unzips to more than it may', async () => {
    expect(await asyncCodeOf(() => gunzipTrack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])))).toBe('bad_gzip');
    // The cap is checked with a smaller one, so the test does not have to unzip 64 MiB (the real cap is the same code).
    const golden = await gzipped(goldenBytes());
    expect(await asyncCodeOf(() => gunzipTrack(golden, { maxBytes: 563 }))).toBe('too_large');
    expect(await asyncCodeOf(() => gunzipTrack(golden, { maxBytes: 564 }))).toBe('no error');
    expect(await asyncCodeOf(() => gunzipTrack(golden, { maxBytes: TRACK_LIMITS.unpackedBytes * 2 }))).toBe('no error');
  });
});

describe('the header', () => {
  const base = () => ({
    game: 'ac',
    track: { name: 'Monza' },
    source: 'fast_lane.ai',
    frame: 'game world',
    closed: true,
    centerKind: 'game_line',
    sections: [{ id: 'centerline', count: 2, channels: ['x', 'y', 'z', 'dist', 'left', 'right'] }],
  });

  it('accepts the smallest valid one', () => {
    expect(parseTrackHeader(base()).sections).toEqual([{ id: 'centerline', count: 2 }]);
  });

  it.each<[string, (h: ReturnType<typeof base>) => void]>([
    ['an upper-case game', (h) => { h.game = 'AC'; }],
    ['a track name that is empty', (h) => { h.track.name = ''; }],
    ['a centerKind it does not know', (h) => { h.centerKind = 'spline'; }],
    ['a fast line without as many points', (h) => { h.sections.push({ id: 'fast', count: 3, channels: ['x', 'z'] } as never); }],
    ['channels in another order', (h) => { h.sections[0].channels = ['y', 'x', 'z', 'dist', 'left', 'right']; }],
    ['a count above the limit', (h) => { h.sections[0].count = TRACK_LIMITS.maxPoints + 1; }],
    ['a count of one', (h) => { h.sections[0].count = 1; }],
    ['the pit lane before the fast line', (h) => { h.sections.push({ id: 'pitlane', count: 2, channels: ['x', 'z', 'left', 'right'] } as never, { id: 'fast', count: 2, channels: ['x', 'z'] } as never); }],
  ])('is refused with %s', (_what, mutate) => {
    const header = base();
    mutate(header);
    expect(codeOf(() => parseTrackHeader(header))).toMatch(/^bad_(header|section)$/);
  });
});
