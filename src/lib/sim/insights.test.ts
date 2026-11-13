import { describe, expect, it } from 'vitest';
import { lapInsights, sessionInsights, type Insight } from './insights';
import type { LapFile } from './lap-file';
import { buildSyntheticLap, exampleCorners, type SynthCorner } from './synthetic-lap';

const LENGTH = 4200;
const SPEC = { first: 0, hairpin: 1, chicaneA: 2, chicaneB: 3, dip: 4, last: 5 };

function lapWith(changes: Array<[number, Partial<SynthCorner>]> = [], options: { hz?: number; noise?: number; seed?: number; sectorsMs?: number[]; valid?: boolean; inLap?: boolean } = {}): LapFile {
  const corners = exampleCorners().map((c, i) => {
    const change = changes.find(([index]) => index === i);
    return change ? { ...c, ...change[1] } : c;
  });
  return buildSyntheticLap({ lengthM: LENGTH, corners, hz: options.hz ?? 20, noise: options.noise ?? 0, seed: options.seed ?? 1, sectorsMs: options.sectorsMs, valid: options.valid, inLap: options.inLap }).lap;
}

const without = (lap: LapFile, ...ids: string[]): LapFile => ({ ...lap, data: Object.fromEntries(Object.entries(lap.data).filter(([id]) => !ids.includes(id))) });
const withTime = (lap: LapFile, timeMs: number): LapFile => ({ ...lap, header: { ...lap.header, lap: { ...lap.header.lap, timeMs } } });

const reference = lapWith();
/** A lap with a loss in three corners of different size: the hairpin brake (largest), the last corner's minimum, the first corner's pickup. */
const slowLap = () => lapWith([[SPEC.hairpin, { brakeDist: 885 }], [SPEC.last, { minSpeedKmh: 87 }], [SPEC.first, { pickupDist: 560, exitSpeedKmh: 133 }]]);

describe('insights for a lap against a reference', () => {
  it('ranks the findings by the time they cost, most first', () => {
    const findings = lapInsights(slowLap(), reference);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < findings.length; i++) expect(findings[i - 1].seconds).toBeGreaterThanOrEqual(findings[i].seconds);
    const byCorner = (corner: number) => findings.find((f) => f.corner === corner);
    expect(byCorner(2)).toMatchObject({ kind: 'brakeEarlier', cause: 'brakesEarly' });
    expect(byCorner(4)).toMatchObject({ kind: 'lostInCorner', cause: 'lowMinSpeed' });
    expect(byCorner(1)).toMatchObject({ kind: 'lostInCorner', cause: 'latePickup' });
    expect(byCorner(2)?.meters).toBeGreaterThan(11);
    expect(byCorner(2)?.meters).toBeLessThan(19);
    expect(byCorner(4)?.kmh).toBeGreaterThan(6);
    expect(byCorner(1)?.meters).toBeGreaterThan(11);
    expect(findings[0].seconds).toBe(Math.max(...findings.map((f) => f.seconds)));
  });

  it('returns at most 5 findings, however many things there are to say', () => {
    const study = lapWith(
      [[SPEC.first, { pickupDist: 560, exitSpeedKmh: 133 }], [SPEC.hairpin, { brakeDist: 880, exitSpeedKmh: 90 }], [SPEC.chicaneB, { minSpeedKmh: 90 }], [SPEC.last, { minSpeedKmh: 80 }]],
      { sectorsMs: [30_000, 28_900, 28_000] },
    );
    const ref = lapWith([], { sectorsMs: [30_000, 28_000, 28_000] });
    const set = [1, 2, 3, 4].map((seed) => lapWith([[SPEC.hairpin, { brakeDist: 880 + seed * 8, minSpeedKmh: 60 + seed * 4 }]], { seed }));
    const all = lapInsights(study, ref, { set, minSeconds: 0.01 });
    expect(all).toHaveLength(5);
    expect(lapInsights(study, ref, { set, minSeconds: 0.01, max: 2 })).toHaveLength(2);
    expect(lapInsights(study, ref, { set, minSeconds: 0.01, max: 50 }).length).toBeLessThanOrEqual(5);
    expect(lapInsights(study, ref, { max: 0 })).toEqual([]);
    // The kinds that were available are the ones that can appear.
    const kinds = new Set(lapInsights(study, ref, { set, minSeconds: 0.01, max: 50 }).map((f) => f.kind));
    expect(kinds.has('sectorGap') || kinds.has('inconsistent') || kinds.has('topSpeedLower')).toBe(true);
  });

  it('says unknownCause when the brake data that would explain the loss is missing', () => {
    const early = lapWith([[SPEC.hairpin, { brakeDist: 885 }]]);
    const known = lapInsights(early, reference)[0];
    expect(known).toMatchObject({ kind: 'brakeEarlier', corner: 2, cause: 'brakesEarly' });
    const blind = lapInsights(without(early, 'brake', 'g_long'), reference)[0];
    expect(blind).toMatchObject({ kind: 'lostInCorner', corner: 2, cause: 'unknownCause' });
    expect(blind.confidence).toBeUndefined();
    expect(blind.meters).toBeUndefined();
    expect(blind.seconds).toBeCloseTo(known.seconds, 1);
  });

  it('says unknownCause without position and throttle data, and none when everything was there and nothing explains it', () => {
    const slow = withTimeDelay(reference, 380, 760, 0.25);
    expect(lapInsights(slow, reference)[0]).toMatchObject({ corner: 1, cause: 'none' });
    expect(lapInsights(without(slow, 'x', 'z'), reference)[0]).toMatchObject({ corner: 1, cause: 'unknownCause' });
    expect(lapInsights(without(slow, 'throttle'), reference)[0]).toMatchObject({ corner: 1, cause: 'unknownCause' });
  });

  it('still names a cause that the speed alone supports when the pedals are missing', () => {
    const low = lapWith([[SPEC.last, { minSpeedKmh: 87 }]]);
    const finding = lapInsights(without(low, 'brake', 'g_long', 'throttle', 'steer', 'x', 'z'), reference)[0];
    expect(finding).toMatchObject({ kind: 'lostInCorner', corner: 4, cause: 'lowMinSpeed' });
  });

  it('reports a lower top speed on a straight', () => {
    const study = lapWith([[SPEC.hairpin, { exitSpeedKmh: 90 }]]);
    const finding = lapInsights(study, reference).find((f) => f.kind === 'topSpeedLower');
    expect(finding).toBeDefined();
    expect(finding?.corner).toBeNull();
    expect(finding?.kmh).toBeGreaterThan(10);
    expect(finding?.seconds).toBeGreaterThan(0);
  });

  it('reports the sector that lost the most', () => {
    const study = lapWith([], { sectorsMs: [30_000, 28_300, 28_300] });
    const ref = lapWith([], { sectorsMs: [30_050, 28_000, 28_250] });
    const finding = lapInsights(study, ref).find((f) => f.kind === 'sectorGap');
    expect(finding).toMatchObject({ kind: 'sectorGap', sector: 2, corner: null, seconds: 0.3, severity: 'high' });
    // Different numbers of sectors, or a gap under the minimum, say nothing.
    expect(lapInsights(study, lapWith([], { sectorsMs: [30_000, 56_000] })).some((f) => f.kind === 'sectorGap')).toBe(false);
    expect(lapInsights(lapWith([], { sectorsMs: [30_000, 28_050, 28_000] }), ref).some((f) => f.kind === 'sectorGap')).toBe(false);
  });

  it('finds the corner the driver is least consistent in across a set of laps', () => {
    const set = [
      [885, 66], [900, 70], [915, 74], [892, 68], [908, 72], [880, 64],
    ].map(([brakeDist, minSpeedKmh], seed) => lapWith([[SPEC.hairpin, { brakeDist, minSpeedKmh }]], { seed: seed + 1 }));
    const finding = lapInsights(reference, reference, { set }).find((f) => f.kind === 'inconsistent');
    expect(finding).toBeDefined();
    expect(finding?.corner).toBe(2);
    expect(finding?.seconds).toBeGreaterThanOrEqual(0.08);
    expect(finding?.meters).toBeGreaterThan(5);
    expect(finding?.kmh).toBeGreaterThan(2);
    // A set of identical laps is consistent; fewer than 3 usable laps is not enough to say.
    const steady = [1, 2, 3, 4].map((seed) => lapWith([], { seed, noise: 1 }));
    expect(lapInsights(reference, reference, { set: steady }).some((f) => f.kind === 'inconsistent')).toBe(false);
    expect(lapInsights(reference, reference, { set: set.slice(0, 2) })).toEqual([]);
    expect(lapInsights(reference, reference, { set: set.map((l) => ({ ...l, header: { ...l.header, lap: { ...l.header.lap, valid: false } } })) })).toEqual([]);
  });

  it('grades the severity by the seconds lost', () => {
    const findings = lapInsights(slowLap(), reference);
    for (const f of findings) expect(f.severity).toBe(f.seconds >= 0.3 ? 'high' : f.seconds >= 0.12 ? 'medium' : 'low');
    const strict = lapInsights(slowLap(), reference, { severity: { high: 0.01, medium: 0.005 } });
    expect(strict.every((f) => f.severity === 'high')).toBe(true);
  });

  it('is deterministic: the same laps give the same findings in the same order', () => {
    const study = slowLap();
    const run = () => JSON.stringify(lapInsights(study, reference));
    expect(run()).toBe(run());
    const noisy = lapWith([[SPEC.hairpin, { brakeDist: 885 }]], { noise: 1, hz: 60, seed: 4 });
    const noisyRef = lapWith([], { noise: 1, seed: 8 });
    expect(JSON.stringify(lapInsights(noisy, noisyRef))).toBe(JSON.stringify(lapInsights(noisy, noisyRef)));
  });

  it('breaks ties between findings in a fixed order', () => {
    const findings: Insight[] = lapInsights(lapWith([[SPEC.first, { exitSpeedKmh: 132 }], [SPEC.last, { exitSpeedKmh: 122 }]]), reference, { minSeconds: 0.005 });
    const keys = findings.map((f) => [f.seconds, f.corner]);
    const sorted = [...keys].sort((p, q) => (q[0] as number) - (p[0] as number) || (p[1] as number) - (q[1] as number));
    expect(keys).toEqual(sorted);
  });

  it('says nothing for a lap against itself, and nothing for laps that cannot be compared', () => {
    expect(lapInsights(reference, reference)).toEqual([]);
    const longer = buildSyntheticLap({ lengthM: LENGTH * 1.1, corners: [] }).lap;
    expect(lapInsights(longer, reference)).toEqual([]);
  });

  it('does not change the laps it is given', () => {
    const study = slowLap();
    const before = JSON.stringify([study.header, Array.from(study.data.speed.slice(0, 50))]);
    lapInsights(study, reference);
    expect(JSON.stringify([study.header, Array.from(study.data.speed.slice(0, 50))])).toBe(before);
  });
});

function withTimeDelay(lap: LapFile, from: number, to: number, seconds: number): LapFile {
  const t = Float32Array.from(lap.data.t, (value, i) => value + seconds * Math.min(1, Math.max(0, (lap.data.dist[i] - from) / (to - from))));
  return { ...lap, header: { ...lap.header, lap: { ...lap.header.lap, timeMs: lap.header.lap.timeMs + Math.round(seconds * 1000) } }, data: { ...lap.data, t } };
}

describe('insights for a session', () => {
  /** Six laps where only the hairpin changes much; the fastest has the most speed through it. */
  const hairpinMinimums = [70, 66, 62, 64, 68, 72];
  const session = () => hairpinMinimums.map((minSpeedKmh, i) => lapWith([[SPEC.hairpin, { minSpeedKmh, brakeDist: 900 + (i % 3) * 6 - 6 }]], { seed: i + 1, noise: 0.5 }));

  it('measures the consistency of the valid laps', () => {
    const laps = [
      withTime(reference, 90_000), withTime(reference, 90_400), withTime(reference, 91_000), withTime(reference, 90_800),
      withTime(reference, 100_000), // much slower: left out
      withTime(lapWith([], { valid: false }), 80_000), // invalid: never counts, not even as the best
      withTime(lapWith([], { inLap: true }), 85_000),
    ];
    const { consistency, bestLapIndex } = sessionInsights(laps);
    expect(consistency).toMatchObject({ lapsConsidered: 4, lapsExcluded: 1, bestMs: 90_000, spreadMs: 1_000, withinOnePercent: 3 });
    expect(consistency?.averageMs).toBeCloseTo(90_550, 6);
    expect(consistency?.medianMs).toBe(90_600);
    expect(consistency?.stdDevMs).toBeCloseTo(Math.sqrt(((550 ** 2) + (150 ** 2) + (450 ** 2) + (250 ** 2)) / 4), 6);
    expect(bestLapIndex).toBe(0);
  });

  it('has no consistency without a valid lap', () => {
    expect(sessionInsights([]).consistency).toBeNull();
    expect(sessionInsights([lapWith([], { valid: false })]).consistency).toBeNull();
  });

  it('finds the corner where the driver varies most across the laps', () => {
    const { mostVariableCorner, cornerSpreads, corners } = sessionInsights(session());
    expect(corners).toHaveLength(4);
    expect(mostVariableCorner?.corner).toBe(2);
    expect(mostVariableCorner?.laps).toBe(6);
    expect(mostVariableCorner?.timeStdS).toBeGreaterThan(0.05);
    expect(mostVariableCorner?.minSpeedStdKmh).toBeGreaterThan(2);
    expect(cornerSpreads[0]).toBe(mostVariableCorner);
    for (let i = 1; i < cornerSpreads.length; i++) expect(cornerSpreads[i - 1].timeStdS).toBeGreaterThanOrEqual(cornerSpreads[i].timeStdS);
    expect(cornerSpreads.filter((s) => s.corner !== 2).every((s) => s.timeStdS < (mostVariableCorner?.timeStdS as number) / 2)).toBe(true);
  });

  it('finds where the best lap beat the average of the others the most', () => {
    const laps = session();
    const { biggestGain, bestVsAverage, bestLapIndex } = sessionInsights(laps);
    expect(bestLapIndex).toBe(5);
    expect(biggestGain?.corner).toBe(2);
    expect(biggestGain?.seconds).toBeGreaterThan(0.05);
    expect(biggestGain?.minSpeedKmh).toBeGreaterThan(3);
    expect(bestVsAverage[0]).toBe(biggestGain);
    for (let i = 1; i < bestVsAverage.length; i++) expect(bestVsAverage[i - 1].seconds).toBeGreaterThanOrEqual(bestVsAverage[i].seconds);
  });

  it('is deterministic, and independent of invalid laps', () => {
    const laps = session();
    expect(JSON.stringify(sessionInsights(laps))).toBe(JSON.stringify(sessionInsights(laps)));
    const withInvalid = [...laps, lapWith([[SPEC.hairpin, { minSpeedKmh: 40 }]], { valid: false })];
    const plain = sessionInsights(laps);
    const mixed = sessionInsights(withInvalid);
    expect(mixed.mostVariableCorner?.timeStdS).toBe(plain.mostVariableCorner?.timeStdS);
    expect(mixed.consistency).toEqual(plain.consistency);
  });

  it('does what it can with fewer than 3 laps', () => {
    const two = sessionInsights(session().slice(0, 2));
    expect(two.consistency?.lapsConsidered).toBe(2);
    expect(two.mostVariableCorner).toBeNull();
    expect(two.bestVsAverage).toEqual([]);
  });
});
