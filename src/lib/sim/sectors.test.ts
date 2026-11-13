import { describe, expect, it } from 'vitest';
import { sectorLapFrom, sectorStandings, summarizeSectors, timeLeftOnTable, type SectorLap } from './sectors';
import { buildSyntheticLap, exampleCorners } from './synthetic-lap';

/** A lap whose time is the sum of its sectors. */
const lap = (id: string, sectorsMs: number[] | null, extra: Partial<SectorLap> = {}): SectorLap => ({
  id, valid: true, timeMs: sectorsMs ? sectorsMs.reduce((a, b) => a + b, 0) : 90_000, sectorsMs, ...extra,
});

const SET: SectorLap[] = [
  lap('a', [30_000, 31_000, 29_000]),
  lap('b', [29_500, 31_500, 29_400]),
  lap('c', [30_400, 30_800, 28_900]),
];

describe('best sectors and the theoretical best lap', () => {
  it('finds the best valid time of each sector and the lap it came from', () => {
    const summary = summarizeSectors(SET);
    expect(summary.sectorCount).toBe(3);
    expect(summary.bests).toEqual([
      { sector: 1, ms: 29_500, lapId: 'b' },
      { sector: 2, ms: 30_800, lapId: 'c' },
      { sector: 3, ms: 28_900, lapId: 'c' },
    ]);
    expect(summary.usedLapIds).toEqual(['a', 'b', 'c']);
    expect(summary.ignored).toEqual([]);
  });

  it('adds the best sectors up to the theoretical best, and reports what it would take off the best lap', () => {
    const summary = summarizeSectors(SET);
    expect(summary.theoreticalBestMs).toBe(29_500 + 30_800 + 28_900);
    expect(summary.bestLapMs).toBe(90_000);
    expect(summary.bestLapId).toBe('a');
    expect(summary.potentialGainMs).toBe(90_000 - 89_200);
    expect(summary.theoreticalBestMs as number).toBeLessThanOrEqual(summary.bestLapMs as number);
  });

  it('reports, per sector, the average time lost and what the best lap left', () => {
    const summary = summarizeSectors(SET);
    expect(summary.perSector[0].bestMs).toBe(29_500);
    expect(summary.perSector[0].averageLossMs).toBeCloseTo((500 + 0 + 900) / 3, 6);
    // The best lap (a) lost 500 ms in sector 1, 200 in sector 2 and 100 in sector 3.
    expect(summary.perSector.map((s) => s.bestLapLossMs)).toEqual([500, 200, 100]);
  });

  for (const count of [2, 3, 4, 5, 6, 7, 8, 9]) {
    it(`works with ${count} sectors`, () => {
      const laps = [1, 2, 3].map((k) => lap(`l${k}`, Array.from({ length: count }, (_, s) => 10_000 + ((s + k) % 3) * 100 + k)));
      const summary = summarizeSectors(laps);
      expect(summary.sectorCount).toBe(count);
      expect(summary.bests).toHaveLength(count);
      expect(summary.theoreticalBestMs).toBe(summary.bests.reduce((sum, b) => sum + b.ms, 0));
      expect(summary.perSector).toHaveLength(count);
    });
  }

  it('refuses a single sector or more than 9', () => {
    const one = summarizeSectors([lap('x', [90_000]), lap('y', [91_000])]);
    expect(one.sectorCount).toBeNull();
    expect(one.ignored.map((i) => i.reason)).toEqual(['bad_sectors', 'bad_sectors']);
    const ten = summarizeSectors([lap('x', Array(10).fill(9_000))]);
    expect(ten.ignored).toEqual([{ id: 'x', reason: 'bad_sectors' }]);
  });
});

describe('which laps count', () => {
  it('never takes a best from an invalid lap', () => {
    const cheat = lap('cut', [20_000, 20_000, 20_000], { valid: false });
    const summary = summarizeSectors([...SET, cheat]);
    expect(summary.theoreticalBestMs).toBe(89_200);
    expect(summary.bests.every((b) => b.lapId !== 'cut')).toBe(true);
    expect(summary.ignored).toEqual([{ id: 'cut', reason: 'invalid' }]);
    expect(summarizeSectors([cheat]).theoreticalBestMs).toBeNull();
  });

  it('ignores laps whose number of sectors differs from the majority', () => {
    const odd = lap('four', [20_000, 20_000, 20_000, 25_000]);
    const summary = summarizeSectors([odd, ...SET]);
    expect(summary.sectorCount).toBe(3);
    expect(summary.usedLapIds).toEqual(['a', 'b', 'c']);
    expect(summary.ignored).toEqual([{ id: 'four', reason: 'count_mismatch' }]);
    expect(summary.theoreticalBestMs).toBe(89_200);
  });

  it('takes the larger count when the laps are split evenly', () => {
    const summary = summarizeSectors([lap('two', [40_000, 50_000]), lap('three', [30_000, 31_000, 29_000])]);
    expect(summary.sectorCount).toBe(3);
    expect(summary.ignored).toEqual([{ id: 'two', reason: 'count_mismatch' }]);
  });

  it('leaves out laps without sectors, pit laps and broken lists, and says why', () => {
    const summary = summarizeSectors([
      ...SET,
      lap('none', null),
      lap('empty', []),
      lap('zero', [0, 45_000, 45_000]),
      lap('nan', [30_000, Number.NaN, 30_000]),
      lap('in', [29_000, 30_000, 28_000], { inLap: true }),
      lap('out', [29_000, 30_000, 28_000], { outLap: true }),
    ]);
    expect(summary.theoreticalBestMs).toBe(89_200);
    expect(summary.ignored).toEqual([
      { id: 'none', reason: 'no_sectors' },
      { id: 'empty', reason: 'no_sectors' },
      { id: 'zero', reason: 'bad_sectors' },
      { id: 'nan', reason: 'bad_sectors' },
      { id: 'in', reason: 'pit_lap' },
      { id: 'out', reason: 'pit_lap' },
    ]);
  });

  it('leaves out a lap whose sectors do not add up to its lap time', () => {
    const broken = lap('short', [30_000, 31_000, 29_000], { timeMs: 99_000 });
    const summary = summarizeSectors([...SET, broken]);
    expect(summary.ignored).toEqual([{ id: 'short', reason: 'sum_mismatch' }]);
    // A lap time of 0 is not checked, and the tolerance can be changed.
    expect(summarizeSectors([lap('unknown', [1, 2].map((x) => x * 1000), { timeMs: 0 })]).usedLapIds).toEqual(['unknown']);
    expect(summarizeSectors([lap('near', [30_000, 31_000, 29_000], { timeMs: 90_400 })]).ignored).toHaveLength(1);
    expect(summarizeSectors([lap('near', [30_000, 31_000, 29_000], { timeMs: 90_400 })], { toleranceMs: 500 }).ignored).toHaveLength(0);
  });

  it('gives an empty summary when no lap can be used', () => {
    const summary = summarizeSectors([lap('x', null)]);
    expect(summary).toMatchObject({ sectorCount: null, bests: [], theoreticalBestMs: null, bestLapMs: null, potentialGainMs: null, usedLapIds: [], perSector: [] });
    expect(summarizeSectors([]).sectorCount).toBeNull();
  });

  it('breaks a tie between equal sector times in favor of the first lap', () => {
    const summary = summarizeSectors([lap('first', [30_000, 30_000]), lap('second', [30_000, 29_000])]);
    expect(summary.bests[0].lapId).toBe('first');
    expect(summary.bests[1].lapId).toBe('second');
  });
});

describe('where each lap stands', () => {
  const summary = summarizeSectors(SET);

  it('marks each sector best-of-set, personal-best or slower', () => {
    // Lap a: sector 1 slower than b's 29.5 s, but the driver's own best of sector 1 is 30.0 s; sector 2 and 3 are slower.
    const standings = sectorStandings(SET[0], summary, [30_000, 30_500, 28_000]);
    expect(standings?.map((s) => s.status)).toEqual(['personal-best', 'slower', 'slower']);
    // Lap c holds two bests of the set.
    expect(sectorStandings(SET[2], summary)?.map((s) => s.status)).toEqual(['slower', 'best-of-set', 'best-of-set']);
    // Lap b has the best first sector, and nothing else.
    expect(sectorStandings(SET[1], summary, [29_500, 31_500, 29_400])?.map((s) => s.status)).toEqual(['best-of-set', 'personal-best', 'personal-best']);
  });

  it('puts best-of-set before personal-best, and ignores a personal-best list of the wrong length', () => {
    expect(sectorStandings(SET[2], summary, [30_400, 30_800, 28_900])?.map((s) => s.status)).toEqual(['personal-best', 'best-of-set', 'best-of-set']);
    expect(sectorStandings(SET[0], summary, [30_000, 31_000])?.map((s) => s.status)).toEqual(['slower', 'slower', 'slower']);
    expect(sectorStandings(SET[0], summary, null)?.map((s) => s.status)).toEqual(['slower', 'slower', 'slower']);
  });

  it('gives the gap to the best and the time left on the table in each sector', () => {
    const standings = sectorStandings(SET[0], summary) ?? [];
    expect(standings.map((s) => s.deltaToBestMs)).toEqual([500, 200, 100]);
    expect(standings.map((s) => s.leftOnTableMs)).toEqual([500, 200, 100]);
    expect(timeLeftOnTable(SET[0], summary)).toEqual({ perSectorMs: [500, 200, 100], totalMs: 800 });
    // A lap that is the best everywhere leaves nothing.
    expect(timeLeftOnTable(lap('ideal', [29_500, 30_800, 28_900]), summary)?.totalMs).toBe(0);
    // A lap outside the set that beats a best has a negative gap and leaves nothing there.
    const faster = sectorStandings(lap('new', [29_000, 31_000, 29_000]), summary) ?? [];
    expect(faster[0]).toMatchObject({ status: 'best-of-set', deltaToBestMs: -500, leftOnTableMs: 0 });
  });

  it('cannot judge an invalid lap, a pit lap, a lap without sectors or one with another count', () => {
    expect(sectorStandings(lap('bad', [1_000, 2_000, 3_000], { valid: false }), summary)).toBeNull();
    expect(sectorStandings(lap('pit', [30_000, 31_000, 29_000], { inLap: true }), summary)).toBeNull();
    expect(sectorStandings(lap('plain', null), summary)).toBeNull();
    expect(sectorStandings(lap('four', [1_000, 2_000, 3_000, 4_000]), summary)).toBeNull();
    expect(timeLeftOnTable(lap('plain', null), summary)).toBeNull();
    expect(sectorStandings(SET[0], summarizeSectors([]))).toBeNull();
  });

  it('builds a sector lap from a lap file', () => {
    const { lap: file } = buildSyntheticLap({ lengthM: 4200, corners: exampleCorners(), sectorsMs: [30_000, 28_000, 28_314], inLap: false });
    const converted = sectorLapFrom(file, 'file-1');
    expect(converted).toMatchObject({ id: 'file-1', valid: true, sectorsMs: [30_000, 28_000, 28_314], inLap: false });
    expect(converted.timeMs).toBe(file.header.lap.timeMs);
    expect(sectorLapFrom(file).id).toBe('1');
    const plain = buildSyntheticLap({ lengthM: 4200, corners: [] }).lap;
    expect(sectorLapFrom(plain).sectorsMs).toBeNull();
  });
});
