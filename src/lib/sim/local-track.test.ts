import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeLapFixtures } from '@/test/lap-fixture';
import { assertLocalTrackAlignment, layoutFitsLap, layoutInLapFrame, localTrackSurface } from './local-track';
import { unpackTrack, type TrackFile } from './track-file';

const page = readFileSync('docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md', 'utf8');
const hex = /```\r?\n([0-9a-f]+)\r?\n```/.exec(page.slice(page.indexOf('Arquivo completo em hexadecimal')))![1];
const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
const [sample] = makeLapFixtures();
const recorder = { app: 'xpeed-companion', version: '0.8.2', build: 'unverified', source: 'acevo' };

describe('account track layouts', () => {
  it('distinguishes game asphalt, native AI corridors and estimated projected widths', () => {
    const track = unpackTrack(bytes);
    const from = (source: string) => ({ ...track, header: { ...track.header, source } });
    expect(localTrackSurface(from('mesh_asphalt'))).toBe('asphalt');
    expect(localTrackSurface(from('ego_white_line'))).toBe('limits');
    expect(localTrackSurface(from('aisplinedata'))).toBe('ai');
    expect(localTrackSurface(from('fast_lane.ai'))).toBe('estimated');
    expect(localTrackSurface({ ...from('fast_lane.ai'), boundaries: { left_x: new Float32Array(), left_z: new Float32Array(), right_x: new Float32Array(), right_z: new Float32Array() } })).toBe('ai');
    expect(localTrackSurface({ ...from('aiw'), boundaries: { left_x: new Float32Array(), left_z: new Float32Array(), right_x: new Float32Array(), right_z: new Float32Array() } })).toBe('ai');
    expect(localTrackSurface(from('unclassified'))).toBe('unknown');
  });
  it('refuses gross coordinate mismatches without transforming either input', () => {
    const track = unpackTrack(bytes);
    const x = [0, 10, 10, 0], z = [0, 0, 10, 10];
    expect(() => assertLocalTrackAlignment(track, x, z)).not.toThrow();
    expect(() => assertLocalTrackAlignment(track, x.map((v) => v + 1000), z)).toThrow('alignment_mismatch');
    expect(x).toEqual([0, 10, 10, 0]);
    expect([...track.centerline.x]).toEqual(x);
  });
});

describe('layoutInLapFrame (EVO coordinate frame)', () => {
  const base = unpackTrack(bytes);
  const shift = (a: Float32Array, by: number) => a.map((v) => v + by);
  const n = base.centerline.x.length;
  // An EVO layout stored reflected, offset from the origin so that a mirrored lap really is far from it.
  const layout: TrackFile = {
    header: { ...base.header, game: 'acevo' },
    centerline: { ...base.centerline, x: shift(base.centerline.x, 100), left: new Float32Array(n).fill(3), right: new Float32Array(n).fill(5) },
    fast: { x: shift(base.centerline.x, 100), z: base.centerline.z.slice() },
    pitlane: { x: shift(base.centerline.x, 100), z: base.centerline.z.slice(), left: new Float32Array(n).fill(1), right: new Float32Array(n).fill(2) },
    boundaries: { left_x: shift(base.centerline.x, 98), left_z: base.centerline.z.slice(), right_x: shift(base.centerline.x, 102), right_z: base.centerline.z.slice() },
  };
  const lapX = [...layout.centerline.x], lapZ = [...layout.centerline.z];
  const mirrored = lapX.map((v) => -v);
  const evo = (coordinateFrame?: string) => ({ ...sample.header, game: 'acevo', startedAt: '2026-11-20T10:00:00Z', recorder: { ...recorder, ...(coordinateFrame ? { coordinateFrame } : {}) } });
  const original = evo('acevo-original-x-v1');

  it('fails the alignment of an original-frame lap before conversion and passes after it', () => {
    expect(() => assertLocalTrackAlignment(layout, mirrored, lapZ)).toThrow('alignment_mismatch');
    expect(layoutFitsLap(layout, original, mirrored, lapZ)).toBe(true);
    expect(() => assertLocalTrackAlignment(layoutInLapFrame(layout, original), mirrored, lapZ)).not.toThrow();
  });
  it('negates X and swaps the driver sides without mutating the input', () => {
    const before = [...layout.centerline.x];
    const out = layoutInLapFrame(layout, original);
    expect(out).not.toBe(layout);
    expect([...out.centerline.x]).toEqual(before.map((v) => -v));
    expect([...layout.centerline.x]).toEqual(before);
    expect([...out.centerline.left]).toEqual([...layout.centerline.right]);
    expect([...out.centerline.right]).toEqual([...layout.centerline.left]);
    expect([...out.fast!.x]).toEqual([...layout.fast!.x].map((v) => -v));
    expect([...out.pitlane!.x]).toEqual([...layout.pitlane!.x].map((v) => -v));
    expect([...out.pitlane!.left]).toEqual([...layout.pitlane!.right]);
    expect([...out.boundaries!.left_x]).toEqual([...layout.boundaries!.right_x].map((v) => -v));
    expect([...out.boundaries!.right_x]).toEqual([...layout.boundaries!.left_x].map((v) => -v));
    expect([...out.boundaries!.left_z]).toEqual([...layout.boundaries!.right_z]);
    expect(out.centerline.z).not.toBe(layout.centerline.z);
  });
  it('leaves reflected, unknown and non-EVO laps and non-EVO layouts untouched', () => {
    expect(layoutInLapFrame(layout, evo('acevo-reflected-x-v1'))).toBe(layout);
    expect(layoutInLapFrame(layout, evo())).toBe(layout);
    expect(layoutInLapFrame(layout, { ...sample.header, game: 'ac' })).toBe(layout);
    expect(layoutInLapFrame(base, original)).toBe(base);
    expect(layoutFitsLap(layout, evo('acevo-reflected-x-v1'), lapX, lapZ)).toBe(true);
    expect(layoutFitsLap(layout, evo(), mirrored, lapZ)).toBe(false);
  });
});
