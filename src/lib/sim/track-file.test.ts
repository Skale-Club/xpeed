import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TRACK_LIMITS, TrackFormatError, gunzipTrack, layoutGame, leftNormals, parseTrackHeader, roadRuns, trackKey, trackKeyOf, unpackTrack,
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

  it('pairs Stock Car Extreme laps (game rfactor1) with its layouts (game sce), and leaves the other games alone', () => {
    expect(layoutGame('rfactor1')).toBe('sce');
    expect(layoutGame('ac')).toBe('ac');
    expect(layoutGame('lmu')).toBe('lmu');
  });
});

describe('a file that is not exactly the spec', () => {
  it.each<[string, (b: Uint8Array) => void, TrackFormatCode]>([
    ['another magic', (b) => { b[0] = 0x59; }, 'bad_magic'],
    ['a newer version', (b) => { b[4] = 3; }, 'bad_version'],
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

/** Synthetic sampled edges deliberately do not follow the midpoint's local normals. No game files are used. */
function sampledFixture() {
  const columns = {
    centerline: { x: [0, 10, 10, 0], y: [0, 0, 0, 0], z: [0, 0, 10, 10], dist: [0, 10, 20, 30], left: [NaN, NaN, NaN, NaN], right: [NaN, NaN, NaN, NaN] },
    boundaries: { left_x: [-4, 7, 8, -2], left_z: [-2, -5, 13, 12], right_x: [3, 14, 15, 4], right_z: [1, 2, 8, 7] },
  };
  const header = {
    game: 'acevo', track: { name: 'Synthetic bends' }, source: 'synthetic native edges', frame: 'game world metres',
    closed: true, centerKind: 'edges_midpoint',
    sections: Object.entries(columns).map(([id, channels]) => ({ id, count: 4, channels: Object.keys(channels) })),
  };
  const pack = (version = 2) => {
    const json = new TextEncoder().encode(JSON.stringify(header));
    const headerSize = Math.ceil(json.length / 4) * 4;
    const values = Object.values(columns).flatMap((section) => Object.values(section).flat());
    const bytes = new Uint8Array(12 + headerSize + values.length * 4);
    bytes.set(new TextEncoder().encode('XTRK'));
    const view = new DataView(bytes.buffer);
    view.setUint16(4, version, true);
    view.setUint32(8, headerSize, true);
    bytes.fill(32, 12, 12 + headerSize);
    bytes.set(json, 12);
    values.forEach((value, index) => view.setFloat32(12 + headerSize + index * 4, value, true));
    return bytes;
  };
  return { header, columns, pack };
}

describe('version 2 sampled boundaries', () => {
  it('preserves asymmetric, non-normal edges exactly even with unknown centre widths', () => {
    const fixture = sampledFixture();
    const track = unpackTrack(fixture.pack());
    expect(track.centerline.left.every(Number.isNaN)).toBe(true);
    expect([...track.boundaries!.left_x]).toEqual(fixture.columns.boundaries.left_x);
    const { runs, closedRing } = roadRuns(track);
    expect(runs).toEqual([{
      left: [[-4, -2], [7, -5], [8, 13], [-2, 12]],
      right: [[3, 1], [14, 2], [15, 8], [4, 7]],
    }]);
    expect(closedRing).toBe(true);
    track.header.closed = false;
    expect(roadRuns(track).closedRing).toBe(false);
  });

  it('splits on unknown boundary rows, without substituting the centre widths or bridging the gap', () => {
    const fixture = sampledFixture();
    Object.values(fixture.columns.boundaries).forEach((values) => { values[1] = NaN; });
    fixture.columns.centerline.left.fill(5);
    fixture.columns.centerline.right.fill(5);
    const { runs, closedRing } = roadRuns(unpackTrack(fixture.pack()));
    expect(runs.map((run) => run.left)).toEqual([[[-4, -2]], [[8, 13], [-2, 12]]]);
    expect(closedRing).toBe(false);
    Object.values(fixture.columns.boundaries).forEach((values) => values.fill(NaN));
    expect(roadRuns(unpackTrack(fixture.pack()))).toEqual({ runs: [], closedRing: false });
  });

  it('accepts edges at the distance limits and distinct edges coincident with the centre', () => {
    const fixture = sampledFixture();
    fixture.columns.boundaries.left_x[0] = -200;
    fixture.columns.boundaries.left_z[0] = 0;
    fixture.columns.boundaries.right_x[0] = 200;
    fixture.columns.boundaries.right_z[0] = 0;
    expect(codeOf(() => unpackTrack(fixture.pack()))).toBe('no error');
    fixture.columns.boundaries.left_x[0] = 0;
    expect(codeOf(() => unpackTrack(fixture.pack()))).toBe('no error');
  });

  it.each<[string, (fixture: ReturnType<typeof sampledFixture>) => void]>([
    ['a partial unknown row', ({ columns }) => { columns.boundaries.left_x[0] = NaN; }],
    ['infinite coordinates', ({ columns }) => { columns.boundaries.right_z[0] = Infinity; }],
    ['a left edge too far from the centre', ({ columns }) => { columns.boundaries.left_x[0] = -201; }],
    ['a right edge too far from the centre', ({ columns }) => { columns.boundaries.right_x[0] = 201; }],
    ['coincident edges', ({ columns }) => {
      columns.boundaries.right_x[0] = columns.boundaries.left_x[0];
      columns.boundaries.right_z[0] = columns.boundaries.left_z[0];
    }],
  ])('refuses %s', (_what, mutate) => {
    const fixture = sampledFixture();
    mutate(fixture);
    expect(codeOf(() => unpackTrack(fixture.pack()))).toBe('bad_data');
  });

  it.each<[string, (fixture: ReturnType<typeof sampledFixture>) => void]>([
    ['missing boundaries', ({ header }) => { header.sections.pop(); }],
    ['a mismatched count', ({ header }) => { header.sections[1].count = 3; }],
    ['reordered channels', ({ header }) => { header.sections[1].channels.reverse(); }],
    ['extra channels', ({ header }) => { header.sections[1].channels.push('y'); }],
    ['boundaries before centerline', ({ header }) => { header.sections.reverse(); }],
    ['boundaries before fast', ({ header }) => { header.sections.push({ id: 'fast', count: 4, channels: ['x', 'z'] }); }],
    ['duplicate boundaries', ({ header }) => { header.sections.push(header.sections[1]); }],
  ])('refuses %s in the header and the file', (_what, mutate) => {
    const fixture = sampledFixture();
    mutate(fixture);
    expect(codeOf(() => parseTrackHeader(fixture.header, 2))).toBe('bad_section');
    expect(codeOf(() => unpackTrack(fixture.pack()))).toBe('bad_section');
  });

  it('allows optional fast and pitlane sections before the final boundaries', () => {
    const fixture = sampledFixture();
    fixture.header.sections.splice(1, 0,
      { id: 'fast', count: 4, channels: ['x', 'z'] },
      { id: 'pitlane', count: 2, channels: ['x', 'z', 'left', 'right'] });
    expect(parseTrackHeader(fixture.header, 2).sections.map((section) => section.id)).toEqual(['centerline', 'fast', 'pitlane', 'boundaries']);
  });

  it('requires v2 boundaries and forbids them in v1, accepting no other versions', () => {
    const fixture = sampledFixture();
    expect(codeOf(() => unpackTrack(fixture.pack(1)))).toBe('bad_section');
    expect(codeOf(() => parseTrackHeader(fixture.header))).toBe('bad_section');
    for (const version of [0, 3, 65535]) {
      expect(codeOf(() => unpackTrack(fixture.pack(version)))).toBe('bad_version');
      expect(codeOf(() => parseTrackHeader(fixture.header, version))).toBe('bad_version');
    }
    const upgradedV1 = copy(goldenBytes());
    new DataView(upgradedV1.buffer).setUint16(4, 2, true);
    expect(codeOf(() => unpackTrack(upgradedV1))).toBe('bad_section');
    expect(unpackTrack(goldenBytes()).boundaries).toBeUndefined();
  });
});
