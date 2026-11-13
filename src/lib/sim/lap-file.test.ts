import { describe, expect, it } from 'vitest';
import { LAP_LIMITS, LapFormatError, gunzipLap, gzipLap, packLap, parseHeader, unpackLap, type LapFile, type LapFormatCode, type LapHeader } from './lap-file';
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
const lap = (): LapFile => ({
  header: structuredClone(HEADER),
  data: { t: new Float32Array([0, 0.5, 1]), dist: new Float32Array([0, 10, 20]), speed: new Float32Array([0, 10, 20]) },
});

/**
 * The same lap laid out byte by byte by a separate script (not by lap-file.ts), so this checks the
 * implementation against an independent reading of the layout. Xpeed Companion must produce these bytes.
 */
const GOLDEN_HEX =
  '584c4150010000005c0100007b2267616d65223a226c6d75222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a224859504552434152227d2c226c6170223a7b226e756d626572223a312c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3630305d7d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d5d7d202020000000000000003f0000803f00000000000020410000a04100000000000020410000a041';
const golden = () => new Uint8Array(Buffer.from(GOLDEN_HEX, 'hex'));
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
  });

  it('reads the golden bytes back into the same lap', () => {
    const read = unpackLap(golden());
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
    ['a newer version', () => { const b = golden(); new DataView(b.buffer).setUint16(4, 2, true); return b; }, 'bad_version'],
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
    ['an empty session id', () => header({ sessionId: '' }), 'bad_header'],
    ['a session id that is not text', () => header({ sessionId: 12 }), 'bad_header'],
    ['a session id of 81 characters', () => header({ sessionId: 'x'.repeat(81) }), 'bad_header'],
    ['weather of 41 characters', () => header({ weather: 'x'.repeat(41) }), 'bad_header'],
    ['an air temperature that is not a number', () => header({ airTempC: '20' }), 'bad_header'],
    ['a track temperature of 900', () => header({ trackTempC: 900 }), 'bad_header'],
    ['an in-lap flag that is not true or false', () => header({ inLap: 1 }), 'bad_header'],
  ] as const)('refuses %s', (_name, make, code) => {
    expect(codeOf(() => parseHeader(make()))).toBe(code);
  });
  it('reads the session details a newer Companion adds, and writes them back', async () => {
    const details = { sessionId: 'abc-123', sessionKind: 'race', weather: 'Rain', airTempC: 14.5, trackTempC: 19, tyreCompound: 'Wet', inLap: false, outLap: true };
    expect(parseHeader(header(details))).toEqual({ ...HEADER, ...details });
    const file: LapFile = { header: { ...structuredClone(HEADER), ...details }, data: lap().data };
    expect((await gunzipLap(await gzipLap(file))).header).toEqual({ ...HEADER, ...details });
  });
  it('writes the same bytes as before when the session details are not given', () => {
    expect(hex(packLap(lap()))).toBe(GOLDEN_HEX);
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
