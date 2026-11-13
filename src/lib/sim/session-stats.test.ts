import { describe, expect, it } from 'vitest';
import { v1Lap } from '@/test/v1-fake-server';
import { bestLapOf, bestSectors, chartRows, consistency, inDrivingOrder, plotRange, sectorTone, theoreticalBest } from './session-stats';

const lap = (n: number, timeMs: number, extra: Parameters<typeof v1Lap>[0] = {}) => v1Lap({ lapNumber: n, timeMs, ...extra });

describe('the best lap and the best sectors', () => {
  const laps = [
    lap(1, 101_000, { sectorsMs: [30_000, 40_000, 31_000] }),
    lap(2, 99_500, { sectorsMs: [29_500, 40_500, 29_500] }),
    lap(3, 98_000, { valid: false, sectorsMs: [28_000, 39_000, 31_000] }), // voided: counts for nothing
    lap(4, 100_200, { sectorsMs: [30_200, 39_800, 30_200] }),
  ];

  it('is the fastest valid lap, and never a voided one', () => {
    expect(bestLapOf(laps)?.lapNumber).toBe(2);
    expect(bestLapOf([lap(1, 90_000, { valid: false })])).toBeNull();
    expect(bestLapOf([])).toBeNull();
  });

  it('takes the best of each sector over the valid laps only', () => {
    expect(bestSectors(laps)).toEqual([29_500, 39_800, 29_500]);
  });

  it('has no sectors when the laps carry none', () => {
    expect(bestSectors([lap(1, 100_000)])).toEqual([]);
    expect(theoreticalBest([])).toBeNull();
  });

  it('puts the best sectors together into the theoretical best lap, which is never slower than the best lap', () => {
    const theoretical = theoreticalBest(bestSectors(laps));
    expect(theoretical).toBe(29_500 + 39_800 + 29_500);
    expect(theoretical!).toBeLessThan(bestLapOf(laps)!.timeMs);
  });

  it('has no theoretical best when a sector has no time', () => {
    expect(theoreticalBest([29_500, null, 29_500])).toBeNull();
  });
});

describe('the colour of a sector', () => {
  const sessionBest = [29_500, 39_800, 29_500];
  const slow = lap(1, 101_000, { sectorsMs: [30_000, 40_000, 31_000] });
  const quick = lap(2, 99_500, { sectorsMs: [29_500, 40_500, 29_500] });

  it('is purple for the best of the session in that sector, even when another lap ties it', () => {
    expect(sectorTone(quick, 0, sessionBest, null)).toBe('purple');
    expect(sectorTone(quick, 2, sessionBest, null)).toBe('purple');
    const tie = lap(3, 100_000, { sectorsMs: [29_500, 41_000, 31_000] });
    expect(sectorTone(tie, 0, sessionBest, null)).toBe('purple');
  });

  it('is yellow when slower, with no personal best to speak of', () => {
    expect(sectorTone(slow, 0, sessionBest, null)).toBe('yellow');
    expect(sectorTone(slow, 1, sessionBest, { lapId: 'some-other-lap' })).toBe('yellow');
  });

  it('is green, where it is not purple, on the lap /v1/pbs says is the personal best for the track and car', () => {
    const pb = { lapId: quick.id };
    expect(sectorTone(quick, 1, sessionBest, pb)).toBe('green'); // 40_500 is slower than the session's best, but this is the personal best lap
    expect(sectorTone(quick, 0, sessionBest, pb)).toBe('purple'); // purple wins over green
    expect(sectorTone(slow, 1, sessionBest, pb)).toBe('yellow'); // another lap
  });

  it('has no colour for a voided lap, a sector with no time, or a sector the lap does not have', () => {
    const voided = lap(4, 98_000, { valid: false, sectorsMs: [28_000, 39_000, 31_000] });
    expect(sectorTone(voided, 0, sessionBest, null)).toBe('none');
    expect(sectorTone(slow, 5, sessionBest, null)).toBe('none');
    expect(sectorTone(lap(5, 100_000), 0, sessionBest, null)).toBe('none');
  });
});

describe('consistency', () => {
  it('works out the spread of the valid laps (sample standard deviation, in seconds), the clean share and the average of the best 3', () => {
    const laps = [lap(1, 100_000), lap(2, 101_000), lap(3, 102_000), lap(4, 99_000, { valid: false })];
    const result = consistency(laps);
    expect(result.spreadS).toBeCloseTo(1, 6); // 100, 101, 102 s: mean 101, deviation 1
    expect(result.cleanPercent).toBeCloseTo(75, 6); // 3 of 4 laps were valid
    expect(result.bestThreeMs).toBe(101_000);
  });

  it('leaves out and in laps out of the spread and the clean share', () => {
    const laps = [lap(1, 125_000, { outLap: true }), lap(2, 100_000), lap(3, 100_000), lap(4, 130_000, { inLap: true, valid: false })];
    const result = consistency(laps);
    expect(result.spreadS).toBe(0);
    expect(result.cleanPercent).toBe(100);
  });

  it('says nothing it cannot know', () => {
    expect(consistency([])).toEqual({ spreadS: null, cleanPercent: null, bestThreeMs: null });
    const two = consistency([lap(1, 100_000), lap(2, 101_000)]);
    expect(two.bestThreeMs).toBeNull(); // fewer than three valid laps
    expect(two.spreadS).not.toBeNull();
    expect(consistency([lap(1, 100_000)]).spreadS).toBeNull();
  });
});

it('puts laps in the order they were driven', () => {
  expect(inDrivingOrder([lap(3, 1), lap(1, 1), lap(2, 1)]).map((entry) => entry.lapNumber)).toEqual([1, 2, 3]);
});

describe('the lap chart', () => {
  it('lets the flying laps decide the range, so a slow out lap does not flatten them', () => {
    const laps = [lap(1, 125_000, { outLap: true }), lap(2, 100_000), lap(3, 100_800), lap(4, 99_900)];
    const range = plotRange(chartRows(laps, laps[3].id));
    expect(range.low).toBeLessThan(99.9);
    expect(range.high).toBeGreaterThan(100.8);
    expect(range.high).toBeLessThan(103); // not stretched to the out lap's 125 s
  });

  it('copes with a session of nothing but pit laps', () => {
    const range = plotRange(chartRows([lap(1, 125_000, { outLap: true })], null));
    expect(range.low).toBeLessThan(125);
    expect(range.high).toBeGreaterThan(125);
  });
});
