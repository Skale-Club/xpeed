import { describe, expect, it } from 'vitest';
import {
  flyingLaps, gapToBest, heatLevel, lapTags, lapTrend, sectorBestHolders, sectorCell, sectorScales, sessionKpis, sortLaps,
} from '@/lib/sim/session-detail';
import { bestLapOf, bestSectors, chartRows } from '@/lib/sim/session-stats';
import { buildInsights } from '@/test/v1-insights';
import { v1Lap } from '@/test/v1-fake-server';

let n = 0;
const lap = (extra: Partial<ReturnType<typeof v1Lap>> = {}) => v1Lap({ lapNumber: ++n, startedAt: new Date(Date.UTC(2026, 10, 10, 12, n)).toISOString(), ...extra });

/** An out lap, three flying laps, a lap the game voided and an in lap. */
const session = () => {
  n = 0;
  return [
    lap({ timeMs: 112_000, outLap: true, sectorsMs: [33_000, 44_000, 35_000] }),
    lap({ timeMs: 99_500, sectorsMs: [29_500, 40_500, 29_500], topSpeedKmh: 310, fuelUsedL: 2 }),
    lap({ timeMs: 98_000, valid: false, sectorsMs: [28_000, 39_000, 31_000] }),
    lap({ timeMs: 100_200, sectorsMs: [30_200, 39_800, 30_200], topSpeedKmh: 300, fuelUsedL: 2.2 }),
    lap({ timeMs: 101_000, sectorsMs: [30_000, 40_000, 31_000], topSpeedKmh: 305, fuelUsedL: 1.8 }),
    lap({ timeMs: 108_000, inLap: true, sectorsMs: [31_000, 41_000, 36_000], fuelUsedL: 9 }),
  ];
};

describe('sessionKpis', () => {
  it('works out the tiles of a session', () => {
    const kpis = sessionKpis(session());
    expect(kpis.best?.timeMs).toBe(99_500);
    expect(kpis.averageMs).toBeCloseTo(100_233.33, 1); // the three flying laps
    expect(kpis.spreadMs).toBeCloseTo(751, 0);
    expect(kpis.laps).toBe(6);
    expect(kpis.validLaps).toBe(5);
    expect(kpis.validPercent).toBe(83);
    expect(kpis.cleanPercent).toBe(75);
    expect(kpis.theoreticalMs).toBe(98_800);
    expect(kpis.theoreticalGainMs).toBe(700);
    expect(kpis.topSpeedKmh).toBe(310);
    expect(kpis.fuelPerLapL).toBeCloseTo(2, 5); // the in lap's 9 L is left out
  });

  it('leaves out what the laps do not carry, and never makes a number up', () => {
    const kpis = sessionKpis([lap({ timeMs: 100_000 }), lap({ timeMs: 100_500 })]);
    expect(kpis.theoreticalMs).toBeNull();
    expect(kpis.theoreticalGainMs).toBeNull();
    expect(kpis.topSpeedKmh).toBeNull();
    expect(kpis.fuelPerLapL).toBeNull();
    expect(kpis.spreadMs).toBeCloseTo(353.55, 1); // two laps are enough for a deviation, as on the session page before
    expect(kpis.averageMs).toBe(100_250);
  });

  it('is empty for no laps and for laps the game all voided', () => {
    const none = sessionKpis([]);
    expect(none).toMatchObject({ best: null, averageMs: null, spreadMs: null, laps: 0, validLaps: 0, validPercent: null, cleanPercent: null, theoreticalMs: null });
    const voided = sessionKpis([lap({ timeMs: 154_252, valid: false, outLap: true })]);
    expect(voided).toMatchObject({ best: null, averageMs: null, validPercent: 0, cleanPercent: null });
    expect(voided.laps).toBe(1);
  });

  it('says the theoretical best gains nothing when the best lap already has every best sector', () => {
    const kpis = sessionKpis([lap({ timeMs: 100_000, sectorsMs: [30_000, 40_000, 30_000] }), lap({ timeMs: 101_000, sectorsMs: [31_000, 40_500, 29_500] })]);
    expect(kpis.theoreticalMs).toBe(99_500 + 0); // 30.000 + 40.000 + 29.500
    expect(kpis.theoreticalGainMs).toBe(500);
    const same = sessionKpis([lap({ timeMs: 100_000, sectorsMs: [30_000, 40_000, 30_000] })]);
    expect(same.theoreticalGainMs).toBe(0);
  });

  it('lists the flying laps', () => {
    expect(flyingLaps(session()).map((l) => l.lapNumber)).toEqual([2, 4, 5]);
  });
});

describe('sortLaps', () => {
  const laps = () => session();
  const numbers = (list: ReturnType<typeof session>) => list.map((l) => l.lapNumber);

  it('sorts by lap number either way', () => {
    expect(numbers(sortLaps(laps(), 'lap', 'asc'))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(numbers(sortLaps(laps().reverse(), 'lap', 'asc'))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(numbers(sortLaps(laps(), 'lap', 'desc'))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('sorts by time with the voided lap after the valid ones in either direction', () => {
    expect(numbers(sortLaps(laps(), 'time', 'asc'))).toEqual([2, 4, 5, 6, 1, 3]);
    expect(numbers(sortLaps(laps(), 'time', 'desc'))).toEqual([1, 6, 5, 4, 2, 3]);
  });

  it('sorts by gap the same way as by time', () => {
    expect(numbers(sortLaps(laps(), 'gap', 'asc'))).toEqual(numbers(sortLaps(laps(), 'time', 'asc')));
  });

  it('keeps the driving order of laps that tie, and does not change the list it is given', () => {
    n = 0;
    const tied = [lap({ timeMs: 100_000 }), lap({ timeMs: 100_000 }), lap({ timeMs: 99_000 })];
    expect(numbers(sortLaps(tied, 'time', 'asc'))).toEqual([3, 1, 2]);
    expect(numbers(tied)).toEqual([1, 2, 3]);
  });

  it('puts laps with no time with the voided ones', () => {
    n = 0;
    const list = [lap({ timeMs: 0 }), lap({ timeMs: 100_000 })];
    expect(numbers(sortLaps(list, 'time', 'asc'))).toEqual([2, 1]);
  });
});

describe('lap tags and gaps', () => {
  it('names what a lap is, in a fixed order', () => {
    const laps = session();
    const best = bestLapOf(laps)!;
    expect(lapTags(laps[0], best.id, best.id)).toEqual(['out']);
    expect(lapTags(laps[1], best.id, best.id)).toEqual(['best', 'pb']);
    expect(lapTags(laps[2], best.id, best.id)).toEqual(['void']);
    expect(lapTags(laps[5], best.id, null)).toEqual(['in']);
    expect(lapTags(laps[3], best.id, best.id)).toEqual([]);
  });

  it('gives the gap of a valid lap in seconds, nothing for a voided lap or with no best lap', () => {
    const laps = session();
    const best = bestLapOf(laps);
    expect(gapToBest(laps[3], best)).toBeCloseTo(0.7, 5);
    expect(gapToBest(laps[1], best)).toBe(0);
    expect(gapToBest(laps[2], best)).toBeNull();
    expect(gapToBest(laps[3], null)).toBeNull();
  });
});

describe('the sector heat', () => {
  it('has levels by how far along the scale of the sector a time is', () => {
    expect(heatLevel(0, 700)).toBe(0);
    expect(heatLevel(-5, 700)).toBe(0);
    expect(heatLevel(100, 700)).toBe(1);
    expect(heatLevel(175, 700)).toBe(1);
    expect(heatLevel(176, 700)).toBe(2);
    expect(heatLevel(350, 700)).toBe(2);
    expect(heatLevel(500, 700)).toBe(3);
    expect(heatLevel(700, 700)).toBe(4);
    expect(heatLevel(5000, 700)).toBe(4);
  });

  it('is level 1 for any time over the best when every lap is alike (a scale of nothing)', () => {
    expect(heatLevel(10, 0)).toBe(1);
    expect(heatLevel(0, 0)).toBe(0);
  });

  it('scales each sector by the slowest flying lap within 7 % of the best lap, not by a lap with a mistake or through the pits', () => {
    const laps = [...session(), lap({ timeMs: 130_000, sectorsMs: [35_000, 50_000, 45_000] })]; // far more than 7 % slower
    const scales = sectorScales(laps, bestSectors(laps));
    expect(scales).toEqual([700, 700, 1500]);
  });

  it('shades a lap’s sector, and leaves pit laps and voided laps uncoloured', () => {
    const laps = session();
    const bests = bestSectors(laps);
    const scales = sectorScales(laps, bests);
    expect(sectorCell(laps[1], 0, bests, scales)).toMatchObject({ kind: 'time', ms: 29_500, deltaMs: 0, level: 0, best: true });
    expect(sectorCell(laps[3], 0, bests, scales)).toMatchObject({ kind: 'time', deltaMs: 700, level: 4, best: false });
    expect(sectorCell(laps[0], 0, bests, scales)).toMatchObject({ kind: 'pit', level: null });
    expect(sectorCell(laps[5], 1, bests, scales)).toMatchObject({ kind: 'pit', level: null });
    expect(sectorCell(laps[2], 0, bests, scales)).toMatchObject({ kind: 'none', ms: 28_000, level: null });
  });

  it('has no sector for a lap without sectors', () => {
    const cell = sectorCell(lap({ timeMs: 100_000 }), 0, [30_000], [0]);
    expect(cell).toEqual({ kind: 'none', ms: null, deltaMs: null, level: null, best: false });
  });

  it('names the lap that holds each best sector (the earlier lap on a tie)', () => {
    n = 0;
    const laps = [lap({ timeMs: 100_000, sectorsMs: [30_000, 41_000] }), lap({ timeMs: 100_500, sectorsMs: [30_000, 40_000] })];
    expect(sectorBestHolders(laps, bestSectors(laps))).toEqual([1, 2]);
    expect(sectorBestHolders(laps, [null, 40_000])).toEqual([null, 2]);
  });
});

describe('lapTrend', () => {
  const rows = (times: number[]) => chartRows(times.map((timeMs) => lap({ timeMs })), null);

  it('is a straight line through the flying laps, with its slope in seconds per lap', () => {
    n = 0;
    const trend = lapTrend(rows([101_000, 100_000, 99_000, 98_000]))!;
    expect(trend.slope).toBeCloseTo(-1, 5);
    expect(trend.values.map((value) => Math.round((value as number) * 10) / 10)).toEqual([101, 100, 99, 98]);
  });

  it('needs three flying laps', () => {
    n = 0;
    expect(lapTrend(rows([100_000, 99_000]))).toBeNull();
    n = 0;
    expect(lapTrend(chartRows([lap({ timeMs: 100_000, outLap: true }), lap({ timeMs: 99_000 }), lap({ timeMs: 98_000 }), lap({ timeMs: 97_000, valid: false })], null))).toBeNull();
  });

  it('is drawn over the span of the flying laps only, and is flat for steady laps', () => {
    n = 0;
    const laps = [lap({ timeMs: 120_000, outLap: true }), lap({ timeMs: 100_000 }), lap({ timeMs: 100_000 }), lap({ timeMs: 100_000 }), lap({ timeMs: 110_000, inLap: true })];
    const trend = lapTrend(chartRows(laps, null))!;
    expect(trend.slope).toBeCloseTo(0, 8);
    expect(trend.values[0]).toBeNull();
    expect(trend.values[4]).toBeNull();
    expect(trend.values[2]).toBeCloseTo(100, 5);
  });
});

describe('buildInsights (the fake of the server’s answer, which the screen harness and the tests use)', () => {
  it('follows the documented answer: usable laps, the sector figures and at most two findings in order', () => {
    const laps = session();
    const answer = buildInsights('s', laps);
    expect(answer).toMatchObject({ sessionId: 's', source: 'metadata', lapsUsed: 3, lapsConsidered: 3 });
    expect(answer.summary.bestLapMs).toBe(99_500);
    expect(answer.summary.averageMs).toBe(100_233);
    expect(answer.findings.map((finding) => finding.kind)).toEqual(['sectorGain', 'sectorSpread']);
    expect(answer.findings[0]).toMatchObject({ kind: 'sectorGain', sector: 2, gainMs: 700 });
  });

  it('has no findings under three usable laps', () => {
    n = 0;
    expect(buildInsights('s', [lap({ timeMs: 100_000 }), lap({ timeMs: 101_000 })]).findings).toEqual([]);
  });
});
