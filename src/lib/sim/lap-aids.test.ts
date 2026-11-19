// The aid class the server stores at ingest (api/sim/_aids.ts) and the check of a lap's aid claim against its own channels.
import { describe, expect, it } from 'vitest';
import { aidsVerdict, checkAidsConsistency, classifyAids, plausibilityWithAids } from '../../../api/sim/_aids';
import { checkPlausibility, CHECKS, PLAUSIBILITY } from '../../../api/sim/_plausibility';
import type { LapAids, LapFile } from './lap-file';

describe('classifyAids', () => {
  const cases: [string, LapAids | undefined, string][] = [
    ['no aids object at all (every lap before the Companion wrote it)', undefined, 'unknown'],
    ['TC and ABS off and nothing else given', { tcMax: 0, absMax: 0 }, 'none'],
    ['everything the game gave is off', { tcMax: 0, absMax: 0, stability: 0, autoShift: false, autoClutch: false, autoBlip: false, idealLine: false }, 'none'],
    ['TC and ABS off, stability on', { tcMax: 0, absMax: 0, stability: 0.5 }, 'no_tc_abs'],
    ['TC and ABS off, automatic gears on', { tcMax: 0, absMax: 0, autoShift: true }, 'no_tc_abs'],
    ['TC and ABS off, ideal line on', { tcMax: 0, absMax: 0, idealLine: true, autoClutch: false }, 'no_tc_abs'],
    ['TC on', { tcMax: 3, absMax: 0 }, 'any'],
    ['ABS on', { tcMax: 0, absMax: 2 }, 'any'],
    ['TC on, ABS not given: the TC on is known', { tcMax: 1 }, 'any'],
    ['ABS on, TC not given', { absMax: 1 }, 'any'],
    ['TC off, ABS not given: a missing aid is not off', { tcMax: 0 }, 'unknown'],
    ['ABS off, TC not given', { absMax: 0 }, 'unknown'],
    ['only the other aids given', { autoShift: false, idealLine: false }, 'unknown'],
  ];
  it.each(cases)('%s', (_name, aids, expected) => expect(classifyAids(aids)).toBe(expected));
});

/** A lap with the channels the checks read; `tc` and `abs` are the number of samples with the flag set. */
function lap(aids: LapAids | undefined, flags: { tc?: number; abs?: number } = {}, samples = 100): LapFile {
  const column = (set: number | undefined) => set === undefined ? undefined : Float32Array.from({ length: samples }, (_v, i) => (i < set ? 1 : 0));
  const t = Float32Array.from({ length: samples }, (_v, i) => (i * 90) / (samples - 1));
  const dist = Float32Array.from({ length: samples }, (_v, i) => (i * 4000) / (samples - 1));
  const speed = Float32Array.from({ length: samples }, () => 40);
  const data: Record<string, Float32Array> = { t, dist, speed };
  const tc = column(flags.tc), abs = column(flags.abs);
  if (tc) data.tc_active = tc;
  if (abs) data.abs_active = abs;
  return {
    header: {
      game: 'lmu', track: { name: 'Ring', lengthM: 4000 }, car: { name: 'Car' },
      lap: { number: 3, timeMs: 90_000, valid: true }, startedAt: '2026-11-19T10:00:00Z', sampleRateHz: (samples - 1) / 90, sampleCount: samples,
      ...(aids ? { aids } : {}), channels: [],
    },
    data,
  } as unknown as LapFile;
}

describe('checkAidsConsistency', () => {
  it('tolerates a few stray samples of an aid the lap says was off', () => {
    const result = checkAidsConsistency(lap({ tcMax: 0, absMax: 0 }, { tc: PLAUSIBILITY.aidActiveSamples, abs: 0 }));
    expect(result).toEqual({ consistent: true, tcActiveSamples: PLAUSIBILITY.aidActiveSamples, absActiveSamples: 0 });
  });

  it('contradicts TC off when TC acts in more than the threshold', () => {
    const result = checkAidsConsistency(lap({ tcMax: 0, absMax: 0 }, { tc: PLAUSIBILITY.aidActiveSamples + 1 }));
    expect(result.consistent).toBe(false);
    expect(result.tcActiveSamples).toBe(PLAUSIBILITY.aidActiveSamples + 1);
  });

  it('contradicts ABS off the same way', () => {
    expect(checkAidsConsistency(lap({ tcMax: 0, absMax: 0 }, { abs: 40 })).consistent).toBe(false);
  });

  it('checks only an aid the lap claims to be 0', () => {
    // TC says 4, so TC acting is expected; ABS says 0 and does not act.
    const result = checkAidsConsistency(lap({ tcMax: 4, absMax: 0 }, { tc: 80, abs: 0 }));
    expect(result).toEqual({ consistent: true, tcActiveSamples: null, absActiveSamples: 0 });
    // Nothing claimed, nothing to contradict.
    expect(checkAidsConsistency(lap(undefined, { tc: 80, abs: 80 })).consistent).toBe(true);
    expect(checkAidsConsistency(lap({ autoShift: true }, { tc: 80 })).consistent).toBe(true);
  });

  it('cannot contradict a claim when the file has no such channel', () => {
    expect(checkAidsConsistency(lap({ tcMax: 0, absMax: 0 }))).toEqual({ consistent: true, tcActiveSamples: null, absActiveSamples: null });
  });
});

describe('aidsVerdict', () => {
  it('keeps the class and the aids of a consistent lap', () => {
    const aids = { tcMax: 0, absMax: 0 };
    expect(aidsVerdict(lap(aids, { tc: 0, abs: 0 }))).toMatchObject({ aidClass: 'none', aids });
  });

  it('moves a contradicted lap to unknown and shows no aids for it', () => {
    expect(aidsVerdict(lap({ tcMax: 0, absMax: 0 }, { tc: 50 }))).toMatchObject({ aidClass: 'unknown', aids: null });
  });

  it('gives null aids when the header has none', () => {
    expect(aidsVerdict(lap(undefined))).toMatchObject({ aidClass: 'unknown', aids: null });
  });
});

describe('plausibilityWithAids', () => {
  it('leaves the stored plausibility as it was for a consistent lap', () => {
    const file = lap({ tcMax: 0, absMax: 0 });
    const result = checkPlausibility(file);
    expect(plausibilityWithAids(result, aidsVerdict(file), file.header.aids)).toEqual({ v: 1, failed: [] });
  });

  it('records the contradiction under its own key and does not make the lap implausible', () => {
    const file = lap({ tcMax: 0, absMax: 0 }, { tc: 30, abs: 2 });
    const result = checkPlausibility(file);
    expect(result.plausible).toBe(true);
    const stored = plausibilityWithAids(result, aidsVerdict(file), file.header.aids);
    expect(stored.failed).toEqual([]);
    expect(stored.aids).toEqual({ consistent: false, tcActiveSamples: 30, absActiveSamples: 2, limit: PLAUSIBILITY.aidActiveSamples, claimed: { tcMax: 0, absMax: 0 } });
  });

  it('leaves the list of checks as it was', () => {
    expect(CHECKS).toEqual(['sector_sum', 'elapsed_time', 'distance', 'speed_range', 'sample_count', 'time_gap']);
  });
});
