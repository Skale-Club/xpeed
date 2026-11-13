import { describe, expect, it } from 'vitest';
import { compareCorners, type CornerComparison } from './corner-compare';
import type { LapFile } from './lap-file';
import { buildSyntheticLap, exampleCorners, scaleCorners, type SynthCorner, type SynthLap } from './synthetic-lap';

const LENGTH = 4200;

function lapWith(patch: (corners: SynthCorner[]) => SynthCorner[] = (c) => c, options: { hz?: number; noise?: number; seed?: number; channels?: Parameters<typeof buildSyntheticLap>[0]['channels']; lengthM?: number } = {}): SynthLap {
  return buildSyntheticLap({ lengthM: options.lengthM ?? LENGTH, corners: patch(exampleCorners()), hz: options.hz ?? 20, noise: options.noise ?? 0, seed: options.seed ?? 1, channels: options.channels });
}

/** The example corners by their place in the list: 1 medium right, 2 hairpin, 3a/3b chicane, dip, 4 long left. */
const SPEC = { first: 0, hairpin: 1, chicaneA: 2, chicaneB: 3, dip: 4, last: 5 };
const edit = (index: number, change: Partial<SynthCorner>) => (corners: SynthCorner[]) => corners.map((c, i) => (i === index ? { ...c, ...change } : c));
const compose = (...patches: Array<(c: SynthCorner[]) => SynthCorner[]>) => (corners: SynthCorner[]) => patches.reduce((acc, patch) => patch(acc), corners);

const reference = lapWith().lap;
const corner = (cmp: CornerComparison, index: number) => cmp.corners.find((c) => c.index === index)!;

/** Adds `seconds` to the clock of a lap, spread over `from`..`to` meters (the speeds are left as they were). */
function delay(lap: LapFile, from: number, to: number, seconds: number): LapFile {
  const t = Float32Array.from(lap.data.t, (value, i) => value + seconds * Math.min(1, Math.max(0, (lap.data.dist[i] - from) / (to - from))));
  return { ...lap, header: { ...lap.header, lap: { ...lap.header.lap, timeMs: lap.header.lap.timeMs + Math.round(seconds * 1000) } }, data: { ...lap.data, t } };
}

/** Moves the path of a lap sideways by `meters` (+ left) over `from`..`to` meters. */
function shiftLine(lap: LapFile, from: number, to: number, meters: number): LapFile {
  const x = Float32Array.from(lap.data.x);
  const z = Float32Array.from(lap.data.z);
  for (let i = 1; i < x.length - 1; i++) {
    const d = lap.data.dist[i];
    if (d < from || d > to) continue;
    const tx = lap.data.x[i + 1] - lap.data.x[i - 1];
    const tz = lap.data.z[i + 1] - lap.data.z[i - 1];
    const length = Math.hypot(tx, tz) || 1;
    x[i] += (-tz / length) * meters;
    z[i] += (tx / length) * meters;
  }
  return { ...lap, data: { ...lap.data, x, z } };
}

const without = (lap: LapFile, ...ids: string[]): LapFile => ({ ...lap, data: Object.fromEntries(Object.entries(lap.data).filter(([id]) => !ids.includes(id))) });

describe('comparing two laps corner by corner', () => {
  it('attributes a lap that brakes 15 m earlier to brakesEarly', () => {
    const study = lapWith(edit(SPEC.hairpin, { brakeDist: 900 - 15 })).lap;
    const cmp = compareCorners(study, reference);
    expect(cmp.comparable).toBe(true);
    const c = corner(cmp, 2);
    expect(c.dominantCause).toBe('brakesEarly');
    expect(c.brakePointM as number).toBeGreaterThan(-19);
    expect(c.brakePointM as number).toBeLessThan(-11);
    expect(c.deltaTime).toBeGreaterThan(0.05);
    expect(c.confidence).toBeGreaterThan(0.5);
    expect(Math.abs(c.minSpeedKmh)).toBeLessThan(1.5);
    // The other corners are the same lap.
    for (const other of cmp.corners.filter((x) => x.index !== 2)) {
      expect(Math.abs(other.deltaTime)).toBeLessThan(0.02);
      expect(other.dominantCause).toBe('none');
    }
  });

  it('attributes a lap that carries 8 km/h less through the apex to lowMinSpeed', () => {
    const study = lapWith(edit(SPEC.last, { minSpeedKmh: 95 - 8 })).lap;
    const c = corner(compareCorners(study, reference), 4);
    expect(c.minSpeedKmh).toBeGreaterThan(-9.5);
    expect(c.minSpeedKmh).toBeLessThan(-6.5);
    expect(c.dominantCause).toBe('lowMinSpeed');
    expect(c.deltaTime).toBeGreaterThan(0.05);
    expect(Math.abs(c.brakePointM as number)).toBeLessThan(3);
  });

  it('attributes a late throttle to latePickup, not to the slow exit it causes', () => {
    const study = lapWith(edit(SPEC.first, { pickupDist: 545 + 15, exitSpeedKmh: 140 - 7 })).lap;
    const c = corner(compareCorners(study, reference), 1);
    expect(c.throttlePickupM as number).toBeGreaterThan(11);
    expect(c.throttlePickupM as number).toBeLessThan(19);
    expect(c.exitSpeedKmh).toBeLessThan(-3);
    expect(c.dominantCause).toBe('latePickup');
    expect(c.deltaTime).toBeGreaterThan(0.05);
    expect(c.causes.map((x) => x.cause)).toContain('slowExit');
  });

  it('names a slow exit only when nothing earlier in the corner explains it', () => {
    const study = lapWith(edit(SPEC.first, { exitSpeedKmh: 140 - 8 })).lap;
    const c = corner(compareCorners(study, reference), 1);
    expect(c.dominantCause).toBe('slowExit');
    expect(c.deltaTime).toBeGreaterThan(0.02);
  });

  it('attributes a late brake that cost speed in the corner to brakesLate', () => {
    const study = lapWith(edit(SPEC.last, { brakeDist: 3000 + 12, minSpeedKmh: 95 - 12 })).lap;
    const c = corner(compareCorners(study, reference), 4);
    expect(c.brakePointM as number).toBeGreaterThan(8);
    expect(c.dominantCause).toBe('brakesLate');
    expect(c.deltaTime).toBeGreaterThan(0.02);
  });

  it('does not blame a late brake that cost nothing', () => {
    const study = lapWith(edit(SPEC.last, { brakeDist: 3000 + 12 })).lap;
    const c = corner(compareCorners(study, reference), 4);
    expect(c.brakePointM as number).toBeGreaterThan(8);
    expect(c.dominantCause).not.toBe('brakesLate');
    expect(c.deltaTime).toBeLessThan(0.02);
  });

  it('blames the gear only when nothing else explains a loss', () => {
    const study = lapWith(edit(SPEC.first, { gear: 2, minSpeedKmh: 110 - 2 })).lap;
    const c = corner(compareCorners(study, reference), 1);
    expect(c.gear).toEqual({ study: 2, reference: 3, differs: true });
    expect(c.deltaTime).toBeGreaterThan(0.02);
    expect(c.dominantCause).toBe('wrongGear');
    // With a clear cause the gear is not the answer.
    const slower = lapWith(edit(SPEC.first, { gear: 2, minSpeedKmh: 110 - 8 })).lap;
    expect(corner(compareCorners(slower, reference), 1).dominantCause).toBe('lowMinSpeed');
  });

  it('blames the line only when the paths are apart and nothing else explains the time', () => {
    const slow = delay(reference, 380, 760, 0.25);
    const sameLine = corner(compareCorners(slow, reference), 1);
    expect(sameLine.deltaTime).toBeGreaterThan(0.1);
    expect(sameLine.dominantCause).toBe('none');
    expect(sameLine.missing).toEqual([]);

    const wide = shiftLine(slow, 440, 600, 2.5);
    const apart = corner(compareCorners(wide, reference), 1);
    expect(Math.abs(apart.lineOffsetM as number)).toBeGreaterThan(2);
    expect(apart.dominantCause).toBe('line');
  });

  it('does not invent a cause when the channels that would tell are missing', () => {
    const slow = delay(without(reference, 'x', 'z', 'brake', 'g_long', 'throttle'), 380, 760, 0.25);
    const c = corner(compareCorners(slow, reference), 1);
    expect(c.deltaTime).toBeGreaterThan(0.1);
    expect(c.dominantCause).toBe('none');
    expect(c.confidence).toBe(0);
    expect(c.missing).toEqual(['brake', 'throttle', 'position']);
    expect(c.brakePointM).toBeNull();
    expect(c.throttlePickupM).toBeNull();
    expect(c.lineOffsetM).toBeNull();
  });

  it('gives no cause for corners where the studied lap gained time', () => {
    const quicker = lapWith(edit(SPEC.last, { minSpeedKmh: 95 + 8 })).lap;
    const c = corner(compareCorners(quicker, reference), 4);
    expect(c.deltaTime).toBeLessThan(-0.05);
    expect(c.dominantCause).toBe('none');
    expect(c.confidence).toBe(0);
  });

  it('finds no differences between a lap and itself', () => {
    const cmp = compareCorners(reference, reference);
    expect(cmp.lapDelta).toBe(0);
    expect(cmp.corners).toHaveLength(4);
    for (const c of cmp.corners) {
      expect(c.deltaTime).toBe(0);
      expect(c.dominantCause).toBe('none');
      expect(c.brakePointM).toBe(0);
      expect(c.minSpeedKmh).toBe(0);
    }
  });
});

describe('the totals add up', () => {
  const study = lapWith(compose(edit(SPEC.hairpin, { brakeDist: 885 }), edit(SPEC.last, { minSpeedKmh: 87 }), edit(SPEC.first, { pickupDist: 560, exitSpeedKmh: 133 }))).lap;

  it('adds the corner deltas and the straight-line delta up to the whole-lap delta within 0.02 s', () => {
    const cmp = compareCorners(study, reference);
    expect(cmp.lapDelta).toBeGreaterThan(0.3);
    expect(Math.abs(cmp.totals.cornersS + cmp.totals.straightsS - cmp.lapDelta)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(cmp.totals.residualS)).toBeLessThan(1e-9);
    // And the lap time the file itself states.
    expect(Math.abs(cmp.lapDelta - cmp.headerDelta)).toBeLessThanOrEqual(0.02);
    expect(cmp.corners.reduce((sum, c) => sum + c.deltaTime, 0)).toBeCloseTo(cmp.totals.cornersS, 9);
    expect(cmp.straights.reduce((sum, s) => sum + s.deltaTime, 0)).toBeCloseTo(cmp.totals.straightsS, 9);
  });

  it('finds the three differences in their corners', () => {
    const cmp = compareCorners(study, reference);
    expect(cmp.corners.map((c) => c.dominantCause)).toEqual(['latePickup', 'brakesEarly', 'none', 'lowMinSpeed']);
  });

  it('cuts the lap into corners and straights that do not overlap and cover it all', () => {
    const cmp = compareCorners(study, reference);
    const pieces = [
      ...cmp.corners.map((c) => [c.startDist, c.endDist] as const),
      ...cmp.straights.map((s) => [s.fromM, s.toM] as const),
    ].sort((p, q) => p[0] - q[0]);
    expect(pieces[0][0]).toBe(0);
    expect(pieces[pieces.length - 1][1]).toBeCloseTo(LENGTH, 6);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i][0]).toBeCloseTo(pieces[i - 1][1], 6);
  });

  it('still adds up when the laps are sampled at different rates, with noise', () => {
    const noisy = lapWith(compose(edit(SPEC.hairpin, { brakeDist: 885 }), edit(SPEC.last, { minSpeedKmh: 87 })), { hz: 60, noise: 1, seed: 5 }).lap;
    const cmp = compareCorners(noisy, lapWith(undefined, { hz: 20, noise: 1, seed: 6 }).lap);
    expect(Math.abs(cmp.totals.cornersS + cmp.totals.straightsS - cmp.lapDelta)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(cmp.lapDelta - cmp.headerDelta)).toBeLessThanOrEqual(0.03);
    expect(corner(cmp, 2).dominantCause).toBe('brakesEarly');
    expect(corner(cmp, 4).dominantCause).toBe('lowMinSpeed');
  });

  it('adds up when a corner of the reference was not found on the studied lap', () => {
    const missing = lapWith((corners) => corners.filter((_, i) => i !== SPEC.last)).lap;
    const cmp = compareCorners(missing, reference);
    expect(cmp.unmatchedReference.map((c) => c.index)).toEqual([4]);
    expect(cmp.corners).toHaveLength(3);
    expect(Math.abs(cmp.totals.cornersS + cmp.totals.straightsS - cmp.lapDelta)).toBeLessThanOrEqual(0.02);
  });

  it('reports the top speed of each lap on each straight', () => {
    // Leaving the hairpin slower means a lower speed at the end of the straight that follows it.
    const slowTop = lapWith(edit(SPEC.hairpin, { exitSpeedKmh: 90 })).lap;
    const cmp = compareCorners(slowTop, reference);
    const straight = cmp.straights.find((s) => s.fromM > 1100 && s.toM < 1500)!;
    expect(straight.topSpeedReferenceKmh - straight.topSpeedStudyKmh).toBeGreaterThan(10);
    expect(straight.deltaTime).toBeGreaterThan(0);
  });
});

describe('laps that cannot be compared', () => {
  it('compares laps whose lengths differ by up to 3% and refuses beyond that', () => {
    const near = buildSyntheticLap({ lengthM: LENGTH * 1.02, corners: scaleCorners(exampleCorners(), 1.02), hz: 20 }).lap;
    const cmp = compareCorners(near, reference);
    expect(cmp.comparable).toBe(true);
    expect(cmp.corners).toHaveLength(4);
    expect(Math.abs(cmp.totals.cornersS + cmp.totals.straightsS - cmp.lapDelta)).toBeLessThanOrEqual(0.02);
    const far = compareCorners(buildSyntheticLap({ lengthM: LENGTH * 1.06, corners: scaleCorners(exampleCorners(), 1.06), hz: 20 }).lap, reference);
    expect(far.comparable).toBe(false);
    expect(far.reason).toBe('length');
    expect(far.corners).toEqual([]);
  });

  it('refuses a lap without the clock or the speed', () => {
    const noClock = lapWith(undefined, { channels: ['dist', 'speed'] }).lap;
    expect(compareCorners(noClock, reference)).toMatchObject({ comparable: false, reason: 'channels' });
    expect(compareCorners(reference, without(reference, 'speed'))).toMatchObject({ comparable: false, reason: 'channels' });
  });
});
