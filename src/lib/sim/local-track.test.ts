import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { assertLocalTrackAlignment, localTrackSurface, LOCAL_TRACK_MAX_BYTES, readLocalTrack } from './local-track';

const page = readFileSync('docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md', 'utf8');
const hex = /```\r?\n([0-9a-f]+)\r?\n```/.exec(page.slice(page.indexOf('Arquivo completo em hexadecimal')))![1];
const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
const file = (data: Uint8Array) => ({ size: data.length, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer });
const wanted = { game: 'ac', name: 'Test Track', variant: 'GP' };

describe('private local track reader', () => {
  it('distinguishes game asphalt, native AI corridors and estimated projected widths', async () => {
    const track = await readLocalTrack(file(bytes), wanted);
    const from = (source: string) => ({ ...track, header: { ...track.header, source } });
    expect(localTrackSurface(from('mesh_asphalt'))).toBe('asphalt');
    expect(localTrackSurface(from('ego_white_line'))).toBe('limits');
    expect(localTrackSurface(from('aisplinedata'))).toBe('ai');
    expect(localTrackSurface(from('fast_lane.ai'))).toBe('estimated');
    expect(localTrackSurface({ ...from('fast_lane.ai'), boundaries: { left_x: new Float32Array(), left_z: new Float32Array(), right_x: new Float32Array(), right_z: new Float32Array() } })).toBe('ai');
    expect(localTrackSurface({ ...from('aiw'), boundaries: { left_x: new Float32Array(), left_z: new Float32Array(), right_x: new Float32Array(), right_z: new Float32Array() } })).toBe('ai');
    expect(localTrackSurface(from('unclassified'))).toBe('unknown');
  });
  it('refuses gross coordinate mismatches without transforming either input', async () => {
    const track = await readLocalTrack(file(bytes), wanted);
    const x = [0, 10, 10, 0], z = [0, 0, 10, 10];
    expect(() => assertLocalTrackAlignment(track, x, z)).not.toThrow();
    expect(() => assertLocalTrackAlignment(track, x.map((v) => v + 1000), z)).toThrow('alignment_mismatch');
    expect(x).toEqual([0, 10, 10, 0]);
    expect([...track.centerline.x]).toEqual(x);
  });
  it('reads raw and gzip without making any network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await readLocalTrack(file(bytes), wanted)).centerline.x.length).toBe(4);
      expect((await readLocalTrack(file(gzipSync(bytes)), wanted)).centerline.x.length).toBe(4);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('normalizes names but refuses another game, track or variant', async () => {
    await expect(readLocalTrack(file(bytes), { game: ' AC ', name: ' test track ', variant: 'gp' })).resolves.toBeDefined();
    for (const mismatch of [{ game: 'acevo' }, { name: 'Other' }, { variant: null }]) {
      await expect(readLocalTrack(file(bytes), { ...wanted, ...mismatch })).rejects.toThrow('identity_mismatch');
    }
  });
  it('bounds input before reading and refuses corrupt raw or gzip bytes', async () => {
    const arrayBuffer = vi.fn();
    await expect(readLocalTrack({ size: LOCAL_TRACK_MAX_BYTES + 1, arrayBuffer }, wanted)).rejects.toMatchObject({ code: 'too_large' });
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(readLocalTrack(file(new Uint8Array(20)), wanted)).rejects.toMatchObject({ code: 'bad_magic' });
    await expect(readLocalTrack(file(Uint8Array.of(0x1f, 0x8b, 0)), wanted)).rejects.toMatchObject({ code: 'bad_gzip' });
  });
});
