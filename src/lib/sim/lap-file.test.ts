import { describe, expect, it } from 'vitest';
import { LAP_LIMITS, LAP_VERSION, LAP_VERSIONS, LapFormatError, SESSION_KINDS, gunzipLap, gzipLap, packLap, parseHeader, unpackLap, type LapFile, type LapFormatCode, type LapHeader } from './lap-file';
import { REQUIRED_CHANNELS, STANDARD_CHANNELS, standardUnit } from './channels';

const HEADER: LapHeader = {
  game: 'lmu',
  track: { name: 'Test Track', variant: 'GP', lengthM: 20 },
  car: { name: 'Test Car', class: 'HYPERCAR' },
  lap: { number: 1, timeMs: 1000, valid: true, sectorsMs: [400, 600] },
  startedAt: '2026-11-10T12:00:00.000Z',
  sampleRateHz: 2,
  sampleCount: 3,
  channels: [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }, { id: 'speed', unit: 'm/s' }],
};
/** The first version of the format: what the golden v1 vector below is. */
const lap = (): LapFile => ({
  header: structuredClone(HEADER),
  data: { t: new Float32Array([0, 0.5, 1]), dist: new Float32Array([0, 10, 20]), speed: new Float32Array([0, 10, 20]) },
  version: 1,
});

/** A version 2 lap: the session, the weather, the tyres, in and out lap, and two of the channels added in version 2. */
const HEADER_V2: LapHeader = {
  game: 'ac',
  track: { name: 'Test Track', variant: 'GP', lengthM: 20 },
  car: { name: 'Test Car', class: 'GT3' },
  lap: { number: 2, timeMs: 1000, valid: true, sectorsMs: [400, 300, 300], inLap: false, outLap: true },
  startedAt: '2026-11-10T12:00:00.000Z',
  sampleRateHz: 2,
  sampleCount: 3,
  sessionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  sessionKind: 'practice',
  weather: 'rain',
  airTempC: 18.5,
  trackTempC: 22,
  tyreCompound: 'Soft',
  channels: [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }, { id: 'speed', unit: 'm/s' }, { id: 'tyre_temp_fl', unit: '°C' }, { id: 'g_lat', unit: 'g' }],
};
const lapV2 = (): LapFile => ({
  header: structuredClone(HEADER_V2),
  data: {
    t: new Float32Array([0, 0.5, 1]), dist: new Float32Array([0, 10, 20]), speed: new Float32Array([0, 10, 20]),
    tyre_temp_fl: new Float32Array([80, Number.NaN, 82]), g_lat: new Float32Array([0, 0.5, -1]),
  },
});

/**
 * The same lap laid out byte by byte by a separate script (not by lap-file.ts), so this checks the
 * implementation against an independent reading of the layout. Xpeed Companion must produce these bytes.
 */
const GOLDEN_HEX =
  '584c4150010000005c0100007b2267616d65223a226c6d75222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a224859504552434152227d2c226c6170223a7b226e756d626572223a312c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3630305d7d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d5d7d202020000000000000003f0000803f00000000000020410000a04100000000000020410000a041';
const golden = () => new Uint8Array(Buffer.from(GOLDEN_HEX, 'hex'));

/**
 * The version 2 golden lap, laid out by the same separate script (docs/telemetria-virtual-2026-11-10/golden-lap.mjs):
 * 648 bytes, with a unit that is not ASCII and a sample the game did not give (NaN). Xpeed Companion must produce
 * these bytes for the same lap.
 */
const GOLDEN_V2_HEX =
  '584c415002000000400200007b2267616d65223a226163222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a22475433227d2c226c6170223a7b226e756d626572223a322c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3330302c3330305d2c22696e4c6170223a66616c73652c226f75744c6170223a747275657d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c2273657373696f6e4964223a226131623263336434653566363037313832393361346235633664376538663930222c2273657373696f6e4b696e64223a227072616374696365222c2277656174686572223a227261696e222c2261697254656d7043223a31382e352c22747261636b54656d7043223a32322c2274797265436f6d706f756e64223a22536f6674222c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d2c7b226964223a22747972655f74656d705f666c222c22756e6974223a22c2b043227d2c7b226964223a22675f6c6174222c22756e6974223a2267227d5d7d20000000000000003f0000803f00000000000020410000a04100000000000020410000a0410000a0420000c07f0000a442000000000000003f000080bf';
const goldenV2 = () => new Uint8Array(Buffer.from(GOLDEN_V2_HEX, 'hex'));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function codeOf(run: () => unknown): LapFormatCode | 'no error' {
  try { run(); } catch (error) { return error instanceof LapFormatError ? error.code : (`other: ${String(error)}` as never); }
  return 'no error';
}
async function codeOfAsync(run: () => Promise<unknown>): Promise<LapFormatCode | 'no error'> {
  try { await run(); } catch (error) { return error instanceof LapFormatError ? error.code : (`other: ${String(error)}` as never); }
  return 'no error';
}
/** The golden bytes with the header text edited in place (same length, so the layout holds). */
function withHeaderEdit(from: string, to: string): Uint8Array {
  expect(to.length).toBe(from.length);
  const bytes = golden();
  const at = Buffer.from(bytes).indexOf(from);
  expect(at).toBeGreaterThan(11);
  bytes.set(Buffer.from(to), at);
  return bytes;
}

describe('the byte layout', () => {
  it('writes exactly the bytes of the golden lap', () => {
    expect(hex(packLap(lap()))).toBe(GOLDEN_HEX);
    expect(golden().length).toBe(396);
  });

  it('reads the golden bytes back into the same lap', () => {
    const read = unpackLap(golden());
    expect(read.version).toBe(1);
    expect(read.header).toEqual(HEADER);
    expect(Array.from(read.data.t)).toEqual([0, 0.5, 1]);
    expect(Array.from(read.data.dist)).toEqual([0, 10, 20]);
    expect(Array.from(read.data.speed)).toEqual([0, 10, 20]);
  });

  it('pads the header to a multiple of 4 so the columns stay aligned', () => {
    const bytes = golden();
    const headerBytes = new DataView(bytes.buffer).getUint32(8, true);
    expect(headerBytes % 4).toBe(0);
    expect(bytes.length).toBe(12 + headerBytes + 3 * 3 * 4);
    const v2 = goldenV2();
    const headerBytesV2 = new DataView(v2.buffer).getUint32(8, true);
    expect(headerBytesV2 % 4).toBe(0);
    expect(v2.length).toBe(12 + headerBytesV2 + 5 * 3 * 4);
  });

  it('writes the same bytes whatever order the input keys came in', () => {
    const shuffled = lap();
    shuffled.header = { channels: HEADER.channels, sampleCount: 3, sampleRateHz: 2, startedAt: HEADER.startedAt, lap: { sectorsMs: [400, 600], valid: true, timeMs: 1000, number: 1 }, car: { class: 'HYPERCAR', name: 'Test Car' }, track: { lengthM: 20, variant: 'GP', name: 'Test Track' }, game: 'lmu' };
    expect(hex(packLap(shuffled))).toBe(GOLDEN_HEX);
  });

  it('leaves out optional fields that are not given', () => {
    const bare = lap();
    bare.header = { ...bare.header, track: { name: 'Test Track' }, car: { name: 'Test Car' }, lap: { number: 1, timeMs: 1000, valid: false } };
    const read = unpackLap(packLap(bare));
    expect(read.header.track).toEqual({ name: 'Test Track' });
    expect(read.header.car).toEqual({ name: 'Test Car' });
    expect(read.header.lap).toEqual({ number: 1, timeMs: 1000, valid: false });
  });

  it('keeps samples the game did not give (NaN) and extra game channels', () => {
    const file = lap();
    file.header.channels.push({ id: 'tyre_fl_temp', unit: 'c' });
    file.data.speed = new Float32Array([0, Number.NaN, 20]);
    file.data.tyre_fl_temp = new Float32Array([80, 81, 82]);
    const read = unpackLap(packLap(file));
    expect(Number.isNaN(read.data.speed[1])).toBe(true);
    expect(Array.from(read.data.tyre_fl_temp)).toEqual([80, 81, 82]);
    expect(read.header.channels.map((channel) => channel.id)).toEqual(['t', 'dist', 'speed', 'tyre_fl_temp']);
  });

  it('reads a file that sits at an odd offset inside a larger buffer', () => {
    const big = new Uint8Array(golden().length + 3);
    big.set(golden(), 3);
    expect(unpackLap(big.subarray(3)).header).toEqual(HEADER);
  });
});

describe('refusing files that are not a well-formed lap', () => {
  it.each([
    ['a file that is too short', () => golden().subarray(0, 5), 'bad_length'],
    ['the wrong magic', () => { const b = golden(); b[0] = 0x59; return b; }, 'bad_magic'],
    ['a newer version', () => { const b = golden(); new DataView(b.buffer).setUint16(4, 3, true); return b; }, 'bad_version'],
    ['version 0', () => { const b = golden(); new DataView(b.buffer).setUint16(4, 0, true); return b; }, 'bad_version'],
    ['a newer version than version 2', () => { const b = goldenV2(); new DataView(b.buffer).setUint16(4, 3, true); return b; }, 'bad_version'],
    ['a version 2 file cut short', () => goldenV2().subarray(0, goldenV2().length - 4), 'bad_length'],
    ['a version 2 file with unknown flags', () => { const b = goldenV2(); b[6] = 1; return b; }, 'bad_flags'],
    ['unknown flags', () => { const b = golden(); b[6] = 1; return b; }, 'bad_flags'],
    ['a header length that is not a multiple of 4', () => { const b = golden(); new DataView(b.buffer).setUint32(8, 349, true); return b; }, 'bad_length'],
    ['a header length past the end of the file', () => { const b = golden(); new DataView(b.buffer).setUint32(8, 0xfffffffc, true); return b; }, 'bad_length'],
    ['a zero header length', () => { const b = golden(); new DataView(b.buffer).setUint32(8, 0, true); return b; }, 'bad_length'],
    ['missing samples at the end', () => golden().subarray(0, golden().length - 4), 'bad_length'],
    ['extra bytes at the end', () => { const b = new Uint8Array(golden().length + 1); b.set(golden()); return b; }, 'bad_length'],
    ['a header that is not JSON', () => withHeaderEdit('{"game"', 'x"game"'), 'bad_header'],
    ['a header that is not UTF-8', () => { const b = golden(); b[20] = 0xff; return b; }, 'bad_header'],
    ['a sample count that does not match the size', () => withHeaderEdit('"sampleCount":3', '"sampleCount":4'), 'bad_length'],
    ['no distance channel', () => withHeaderEdit('{"id":"dist"', '{"id":"disx"'), 'bad_channels'],
    ['a standard channel in the wrong unit', () => withHeaderEdit('"unit":"m/s"', '"unit":"m/h"'), 'bad_channels'],
  ] as const)('%s', (_name, make, code) => {
    expect(codeOf(() => unpackLap(make()))).toBe(code);
  });
});

describe('checking an untrusted header', () => {
  const header = (patch: Record<string, unknown>) => ({ ...structuredClone(HEADER), ...patch });
  it('accepts a good header', () => {
    expect(parseHeader(structuredClone(HEADER))).toEqual(HEADER);
  });
  it.each([
    ['not an object', () => [], 'bad_header'],
    ['an upper-case game id', () => header({ game: 'LMU' }), 'bad_header'],
    ['no track name', () => header({ track: {} }), 'bad_header'],
    ['a track length of zero', () => header({ track: { name: 'x', lengthM: 0 } }), 'bad_header'],
    ['a negative lap time', () => header({ lap: { number: 1, timeMs: -1, valid: true } }), 'bad_header'],
    ['a fractional lap number', () => header({ lap: { number: 1.5, timeMs: 1000, valid: true } }), 'bad_header'],
    ['a lap that is not true or false', () => header({ lap: { number: 1, timeMs: 1000, valid: 'yes' } }), 'bad_header'],
    ['nine sectors', () => header({ lap: { number: 1, timeMs: 1000, valid: true, sectorsMs: new Array(9).fill(1) } }), 'bad_header'],
    ['a start date that is not a date', () => header({ startedAt: 'yesterday' }), 'bad_header'],
    ['a sample rate of zero', () => header({ sampleRateHz: 0 }), 'bad_header'],
    ['an infinite sample rate', () => header({ sampleRateHz: Infinity }), 'bad_header'],
    ['no samples', () => header({ sampleCount: 0 }), 'bad_header'],
    ['too many samples', () => header({ sampleCount: LAP_LIMITS.samples + 1 }), 'bad_header'],
    ['one channel', () => header({ channels: [{ id: 't', unit: 's' }] }), 'bad_channels'],
    ['too many channels', () => header({ channels: Array.from({ length: LAP_LIMITS.channels + 1 }, (_, i) => ({ id: `c${i}`, unit: 'x' })) }), 'bad_channels'],
    ['the same channel twice', () => header({ channels: [...HEADER.channels, { id: 'speed', unit: 'm/s' }] }), 'bad_channels'],
    ['a channel id with a space', () => header({ channels: [...HEADER.channels, { id: 'tyre temp', unit: 'c' }] }), 'bad_channels'],
    ['a channel id that starts with a digit', () => header({ channels: [...HEADER.channels, { id: '1st', unit: 'c' }] }), 'bad_channels'],
    ['a channel with no unit', () => header({ channels: [...HEADER.channels, { id: 'extra', unit: '' }] }), 'bad_channels'],
    ['no time channel', () => header({ channels: [{ id: 'dist', unit: 'm' }, { id: 'speed', unit: 'm/s' }] }), 'bad_channels'],
  ] as const)('refuses %s', (_name, make, code) => {
    expect(codeOf(() => parseHeader(make()))).toBe(code);
  });
});

describe('packing a lap that is not valid', () => {
  it.each([
    ['a column of the wrong length', (file: LapFile) => { file.data.speed = new Float32Array(2); }],
    ['a missing column', (file: LapFile) => { delete file.data.speed; }],
    ['a column that is not float32', (file: LapFile) => { (file.data as Record<string, unknown>).speed = [0, 1, 2]; }],
  ])('refuses %s', (_name, damage) => {
    const file = lap();
    damage(file);
    expect(codeOf(() => packLap(file))).toBe('bad_data');
  });

  it('refuses a header that does not pass the checks', () => {
    const file = lap();
    file.header.sampleRateHz = -1;
    expect(codeOf(() => packLap(file))).toBe('bad_header');
  });
});

describe('the gzip file', () => {
  it('goes through compression and back unchanged', async () => {
    const zipped = await gzipLap(lap());
    expect(zipped[0]).toBe(0x1f);
    expect(zipped[1]).toBe(0x8b);
    const read = await gunzipLap(zipped);
    expect(read.header).toEqual(HEADER);
    expect(Array.from(read.data.dist)).toEqual([0, 10, 20]);
  });

  it('reads gzip data compressed elsewhere', async () => {
    const { gzipSync } = await import('node:zlib');
    const read = await gunzipLap(new Uint8Array(gzipSync(Buffer.from(golden()))));
    expect(read.header).toEqual(HEADER);
  });

  it('compresses a real-sized lap well below its raw size', async () => {
    const samples = 7200; // two minutes at 60 Hz
    const file: LapFile = {
      header: { ...HEADER, sampleCount: samples, sampleRateHz: 60 },
      data: {
        t: Float32Array.from({ length: samples }, (_, i) => i / 60),
        dist: Float32Array.from({ length: samples }, (_, i) => i * 0.9),
        speed: Float32Array.from({ length: samples }, (_, i) => 30 + 20 * Math.sin(i / 300)),
      },
    };
    const raw = packLap(file).length;
    const zipped = await gzipLap(file);
    expect(zipped.length).toBeLessThan(raw);
    expect((await gunzipLap(zipped)).header.sampleCount).toBe(samples);
  });

  it('refuses bytes that are not gzip', async () => {
    expect(await codeOfAsync(() => gunzipLap(new Uint8Array([1, 2, 3, 4])))).toBe('bad_gzip');
  });

  it('refuses a truncated gzip file', async () => {
    const zipped = await gzipLap(lap());
    expect(await codeOfAsync(() => gunzipLap(zipped.subarray(0, zipped.length - 6)))).toBe('bad_gzip');
  });

  it('stops a small file that unzips to something huge', async () => {
    const samples = 400_000;
    const big: LapFile = {
      header: { ...HEADER, sampleCount: samples, sampleRateHz: 60 },
      data: { t: new Float32Array(samples), dist: new Float32Array(samples), speed: new Float32Array(samples) },
    };
    const zipped = await gzipLap(big);
    expect(zipped.length).toBeLessThan(100_000); // zeros compress to almost nothing
    expect(await codeOfAsync(() => gunzipLap(zipped, { maxBytes: 1024 * 1024 }))).toBe('too_large');
    expect((await gunzipLap(zipped)).header.sampleCount).toBe(samples); // under the default cap it is fine
  });
});

describe('the standard channels', () => {
  it('require the clock and the distance', () => {
    expect([...REQUIRED_CHANNELS].sort()).toEqual(['dist', 't']);
  });
  it('have one unit each, and unknown channels have none', () => {
    expect(standardUnit('speed')).toBe('m/s');
    expect(standardUnit('throttle')).toBe('ratio');
    expect(standardUnit('tyre_fl_temp')).toBeNull();
    expect(standardUnit('constructor')).toBeNull();
    expect(Object.keys(STANDARD_CHANNELS)).toContain('steer');
  });
});

describe('version 1 and version 2 files', () => {
  it('writes version 2 unless told otherwise, and reads versions 1 and 2', () => {
    expect([...LAP_VERSIONS]).toEqual([1, 2]);
    expect(LAP_VERSION).toBe(2);
    const { version: _omit, ...unversioned } = lap();
    const bytes = packLap(unversioned);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true)).toBe(2);
    expect(unpackLap(bytes).version).toBe(2);
    expect(unpackLap(golden()).version).toBe(1);
  });

  it('writes exactly the bytes of the golden version 2 lap', () => {
    expect(hex(packLap(lapV2()))).toBe(GOLDEN_V2_HEX);
    expect(goldenV2().length).toBe(648);
  });

  it('reads the golden version 2 bytes back into the same lap', () => {
    const read = unpackLap(goldenV2());
    expect(read.version).toBe(2);
    expect(read.header).toEqual(HEADER_V2);
    expect(Array.from(read.data.tyre_temp_fl).map((v) => (Number.isNaN(v) ? 'NaN' : v))).toEqual([80, 'NaN', 82]);
    expect(Array.from(read.data.g_lat)).toEqual([0, 0.5, -1]);
    expect(read.header.channels.find((channel) => channel.id === 'tyre_temp_fl')?.unit).toBe('°C');
  });

  it('keeps the version a file was read in when it is written again', () => {
    expect(hex(packLap(unpackLap(golden())))).toBe(GOLDEN_HEX);
    expect(hex(packLap(unpackLap(goldenV2())))).toBe(GOLDEN_V2_HEX);
  });

  it('writes the same bytes whatever order the version 2 keys came in', () => {
    const shuffled = lapV2();
    const h = HEADER_V2;
    shuffled.header = {
      channels: h.channels, tyreCompound: h.tyreCompound, trackTempC: h.trackTempC, airTempC: h.airTempC, weather: h.weather, sessionKind: h.sessionKind,
      sessionId: h.sessionId, sampleCount: h.sampleCount, sampleRateHz: h.sampleRateHz, startedAt: h.startedAt,
      lap: { outLap: true, inLap: false, sectorsMs: [400, 300, 300], valid: true, timeMs: 1000, number: 2 }, car: h.car, track: h.track, game: h.game,
    };
    expect(hex(packLap(shuffled))).toBe(GOLDEN_V2_HEX);
  });

  it('leaves out version 2 fields that are not given', () => {
    const bare = lapV2();
    bare.header = { ...bare.header, lap: { number: 1, timeMs: 1000, valid: true } };
    for (const key of ['sessionId', 'sessionKind', 'weather', 'airTempC', 'trackTempC', 'tyreCompound'] as const) delete bare.header[key];
    const text = Buffer.from(packLap(bare)).toString('latin1');
    for (const key of ['sessionId', 'sessionKind', 'weather', 'airTempC', 'trackTempC', 'tyreCompound', 'inLap', 'outLap']) expect(text).not.toContain(key);
    expect(unpackLap(packLap(bare)).header.sessionId).toBeUndefined();
  });

  it('refuses to write a version 1 file that carries version 2 fields', () => {
    const file = lapV2();
    file.version = 1;
    expect(codeOf(() => packLap(file))).toBe('bad_header');
    expect(codeOf(() => packLap({ ...lap(), version: 3 as never }))).toBe('bad_version');
  });

  it('reads a version 1 file with the version 1 header, and no version 2 field turns up', () => {
    const read = unpackLap(golden());
    for (const key of ['sessionId', 'sessionKind', 'weather', 'airTempC', 'trackTempC', 'tyreCompound'] as const) expect(read.header[key]).toBeUndefined();
    expect(read.header.lap.inLap).toBeUndefined();
  });

  it('goes through gzip in both versions', async () => {
    expect((await gunzipLap(await gzipLap(lapV2()))).header).toEqual(HEADER_V2);
    expect((await gunzipLap(await gzipLap(lap()))).version).toBe(1);
    const { gzipSync } = await import('node:zlib');
    expect((await gunzipLap(new Uint8Array(gzipSync(Buffer.from(goldenV2()))))).header).toEqual(HEADER_V2);
  });
});

describe('checking the version 2 header fields', () => {
  const header = (patch: Record<string, unknown>) => ({ ...structuredClone(HEADER_V2), ...patch });
  const lapWith = (patch: Record<string, unknown>) => ({ ...structuredClone(HEADER_V2).lap, ...patch });
  it('accepts a good header and each session kind', () => {
    expect(parseHeader(structuredClone(HEADER_V2))).toEqual(HEADER_V2);
    for (const kind of SESSION_KINDS) expect(parseHeader(header({ sessionKind: kind })).sessionKind).toBe(kind);
  });
  it.each([
    ['an empty session id', () => header({ sessionId: '' })],
    ['a session id with a space', () => header({ sessionId: 'not a session' })],
    ['a session id of 65 characters', () => header({ sessionId: 'a'.repeat(65) })],
    ['a session id that is a number', () => header({ sessionId: 12345 })],
    ['a session kind that is not one of the four', () => header({ sessionKind: 'drift' })],
    ['an upper-case session kind', () => header({ sessionKind: 'Race' })],
    ['an empty weather', () => header({ weather: '' })],
    ['a weather of 33 characters', () => header({ weather: 'w'.repeat(33) })],
    ['a weather with a line break', () => header({ weather: 'rain\nsnow' })],
    ['an air temperature that is not a number', () => header({ airTempC: '18' })],
    ['an air temperature of 201', () => header({ airTempC: 201 })],
    ['a track temperature of -101', () => header({ trackTempC: -101 })],
    ['an infinite track temperature', () => header({ trackTempC: Infinity })],
    ['an empty tyre compound', () => header({ tyreCompound: '' })],
    ['a tyre compound of 41 characters', () => header({ tyreCompound: 'c'.repeat(41) })],
    ['an in lap that is not true or false', () => header({ lap: lapWith({ inLap: 1 }) })],
    ['an out lap that is not true or false', () => header({ lap: lapWith({ outLap: 'yes' }) })],
  ])('refuses %s', (_name, make) => {
    expect(codeOf(() => parseHeader(make()))).toBe('bad_header');
  });
  it('accepts the longest session id, weather and compound', () => {
    const edge = parseHeader(header({ sessionId: 'S'.repeat(64), weather: 'w'.repeat(32), tyreCompound: 'c'.repeat(40), airTempC: -100, trackTempC: 200 }));
    expect(edge.sessionId).toHaveLength(64);
  });
  it('ignores a key it does not know', () => {
    expect(parseHeader(header({ somethingFromVersion3: true }))).toEqual(HEADER_V2);
  });
});

describe('the channels added in version 2 and the limits that stay', () => {
  const NEW_CHANNELS = [
    ...['fl', 'fr', 'rl', 'rr'].flatMap((w) => [`tyre_temp_${w}`, `tyre_press_${w}`, `tyre_wear_${w}`, `brake_temp_${w}`]),
    'g_lat', 'g_long', 'damage_body', 'drs', 'tc_active', 'abs_active',
  ];
  const everyChannelLap = (): LapFile => {
    const channels = [...HEADER.channels, ...NEW_CHANNELS.map((id) => ({ id, unit: standardUnit(id) as string }))];
    const data: Record<string, Float32Array> = { t: new Float32Array([0, 0.5, 1]), dist: new Float32Array([0, 10, 20]), speed: new Float32Array([0, 10, 20]) };
    for (const id of NEW_CHANNELS) data[id] = new Float32Array([1, 2, 3]);
    return { header: { ...structuredClone(HEADER), channels }, data };
  };

  it('are standard channels with one unit each', () => {
    expect(NEW_CHANNELS).toHaveLength(22);
    for (const id of NEW_CHANNELS) expect(standardUnit(id), id).not.toBeNull();
    expect(standardUnit('tyre_temp_fl')).toBe('°C');
    expect(standardUnit('brake_temp_rr')).toBe('°C');
    expect(standardUnit('tyre_press_fr')).toBe('kPa');
    expect(standardUnit('tyre_wear_rl')).toBe('ratio');
    expect(standardUnit('g_lat')).toBe('g');
    expect(standardUnit('g_long')).toBe('g');
    expect(standardUnit('damage_body')).toBe('ratio');
    expect(standardUnit('drs')).toBe('state');
    expect(standardUnit('tc_active')).toBe('flag');
    expect(standardUnit('abs_active')).toBe('flag');
    expect(Object.keys(STANDARD_CHANNELS)).toHaveLength(13 + 22);
  });

  it('are valid channel ids (lower case, digits and underscores), so an old reader accepts them as game channels', () => {
    for (const id of Object.keys(STANDARD_CHANNELS)) expect(id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });

  it('round trip with all of them present', async () => {
    const file = everyChannelLap();
    expect(file.header.channels).toHaveLength(3 + 22);
    const read = await gunzipLap(await gzipLap(file));
    expect(read.header.channels).toHaveLength(25);
    expect(Array.from(read.data.tyre_wear_rr)).toEqual([1, 2, 3]);
    expect(Array.from(read.data.abs_active)).toEqual([1, 2, 3]);
  });

  it('refuse a new standard channel in the wrong unit', () => {
    for (const [id, wrong] of [['tyre_temp_fl', 'C'], ['tyre_press_fl', 'psi'], ['g_lat', 'm/s2'], ['drs', 'ratio']]) {
      const file = everyChannelLap();
      const channel = file.header.channels.find((c) => c.id === id)!;
      channel.unit = wrong;
      expect(codeOf(() => packLap(file)), id).toBe('bad_channels');
    }
  });

  it('still hold the channel count limits: 2 to 128, no repeats, t and dist required', () => {
    const many = (count: number): LapFile => {
      const channels = [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }, ...Array.from({ length: count - 2 }, (_, i) => ({ id: `extra_${i}`, unit: 'x' }))];
      const data: Record<string, Float32Array> = {};
      for (const { id } of channels) data[id] = new Float32Array(3);
      return { header: { ...structuredClone(HEADER), channels }, data };
    };
    expect(unpackLap(packLap(many(LAP_LIMITS.channels))).header.channels).toHaveLength(LAP_LIMITS.channels);
    expect(codeOf(() => packLap(many(LAP_LIMITS.channels + 1)))).toBe('bad_channels');
    const one = many(2);
    one.header.channels = [{ id: 't', unit: 's' }];
    expect(codeOf(() => packLap(one))).toBe('bad_channels');
    const twice = everyChannelLap();
    twice.header.channels.push({ id: 'g_lat', unit: 'g' });
    expect(codeOf(() => packLap(twice))).toBe('bad_channels');
  });

  it('still hold the other limits in version 2', () => {
    const header = (patch: Record<string, unknown>) => ({ ...structuredClone(HEADER_V2), ...patch });
    expect(codeOf(() => parseHeader(header({ sampleCount: LAP_LIMITS.samples + 1 })))).toBe('bad_header');
    expect(codeOf(() => parseHeader(header({ track: { name: 'x'.repeat(121) } })))).toBe('bad_header');
    expect(codeOf(() => parseHeader(header({ lap: { ...HEADER_V2.lap, sectorsMs: new Array(9).fill(1) } })))).toBe('bad_header');
    const tooBig = goldenV2();
    new DataView(tooBig.buffer).setUint32(8, LAP_LIMITS.headerBytes + 4, true);
    expect(codeOf(() => unpackLap(tooBig))).toBe('bad_length');
  });

  it('stop a small version 2 file that unzips to something huge', async () => {
    const samples = 400_000;
    const big: LapFile = {
      header: { ...HEADER_V2, sampleCount: samples, sampleRateHz: 60 },
      data: {
        t: new Float32Array(samples), dist: new Float32Array(samples), speed: new Float32Array(samples),
        tyre_temp_fl: new Float32Array(samples), g_lat: new Float32Array(samples),
      },
    };
    const zipped = await gzipLap(big);
    expect(zipped.length).toBeLessThan(100_000);
    expect(await codeOfAsync(() => gunzipLap(zipped, { maxBytes: 1024 * 1024 }))).toBe('too_large');
    expect((await gunzipLap(zipped)).version).toBe(2);
  });
});
