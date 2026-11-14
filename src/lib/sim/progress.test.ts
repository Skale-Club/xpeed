import { describe, expect, it } from 'vitest';
import { bestRange, carProgress, carProgressTracks, trackProgress } from '@/lib/sim/progress';

const monza = { id: 'c1', name: 'Ferrari 499P' };
const progress = {
  bestPerDay: [
    { day: '2026-11-03', bestMs: 101_400, lapId: 'lap-a', car: monza },
    { day: '2026-11-06', bestMs: 100_900, lapId: 'lap-b', car: monza },
    { day: '2026-11-12', bestMs: 99_800, lapId: 'lap-c', car: { id: 'c2', name: 'Toyota GR010' } },
  ],
  lapsPerDay: [
    { day: '2026-11-03', laps: 7, validLaps: 5 },
    { day: '2026-11-06', laps: 9, validLaps: 8 },
    { day: '2026-11-09', laps: 3, validLaps: 0 },
    { day: '2026-11-12', laps: 14, validLaps: 11 },
  ],
};

describe('the progress of a track', () => {
  it('has a row for every day with laps, oldest first, with the best valid lap in seconds', () => {
    const rows = trackProgress(progress);
    expect(rows.map((row) => row.day)).toEqual(['2026-11-03', '2026-11-06', '2026-11-09', '2026-11-12']);
    expect(rows.map((row) => row.bestS)).toEqual([101.4, 100.9, null, 99.8]);
    expect(rows.map((row) => row.laps)).toEqual([7, 9, 3, 14]);
    expect(rows.map((row) => row.validLaps)).toEqual([5, 8, 0, 11]);
  });

  it('keeps the lap and the car of the best of each day, to open the lap and name the car', () => {
    const rows = trackProgress(progress);
    expect(rows[0]).toMatchObject({ lapId: 'lap-a', car: 'Ferrari 499P' });
    expect(rows[3]).toMatchObject({ lapId: 'lap-c', car: 'Toyota GR010' });
    expect(rows[2]).toMatchObject({ lapId: null, car: null });
  });

  it('puts days on a time axis (midnight UTC), so gaps between days show as gaps', () => {
    const rows = trackProgress(progress);
    expect(rows[0].at).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
    expect(rows[3].at - rows[0].at).toBe(9 * 86_400_000);
  });

  it('has a row for a day that has a best lap but no lap count, whatever order the API lists them in', () => {
    const rows = trackProgress({ bestPerDay: [{ day: '2026-11-05', bestMs: 100_000, lapId: 'x', car: monza }], lapsPerDay: [{ day: '2026-11-01', laps: 1, validLaps: 1 }] });
    expect(rows.map((row) => row.day)).toEqual(['2026-11-01', '2026-11-05']);
    expect(rows[1]).toMatchObject({ bestS: 100, laps: 0 });
  });

  it('is empty for a track nobody drove', () => {
    expect(trackProgress({ bestPerDay: [], lapsPerDay: [] })).toEqual([]);
    expect(bestRange([])).toBeNull();
  });

  it('chooses a y range around the daily bests with room to read small gains', () => {
    const range = bestRange(trackProgress(progress))!;
    expect(range.low).toBeLessThanOrEqual(99.5);
    expect(range.high).toBeGreaterThanOrEqual(101.7);
    expect(range.high - range.low).toBeLessThan(4);
  });
});

describe('the progress of a car', () => {
  const spa = { id: 't1', name: 'Spa-Francorchamps' };
  const imola = { id: 't2', name: 'Imola' };
  const days = [{ day: '2026-11-09', laps: 3, validLaps: 2 }, { day: '2026-11-03', laps: 7, validLaps: 5 }, { day: '2026-11-05', laps: 2, validLaps: 2 }];
  const bestPerDay = [
    { day: '2026-11-03', bestMs: 140_000, lapId: 'a', track: spa }, { day: '2026-11-03', bestMs: 95_000, lapId: 'b', track: imola },
    { day: '2026-11-05', bestMs: 94_500, lapId: 'c', track: imola }, { day: '2026-11-09', bestMs: 139_000, lapId: 'd', track: spa },
  ];

  it('is laps per day, oldest first, with no best lap when no track is chosen', () => {
    const rows = carProgress({ bestPerDay, lapsPerDay: days });
    expect(rows.map((row) => [row.day, row.laps, row.bestS])).toEqual([['2026-11-03', 7, null], ['2026-11-05', 2, null], ['2026-11-09', 3, null]]);
    expect(carProgress({ bestPerDay: [], lapsPerDay: days }).every((row) => row.bestS === null)).toBe(true);
  });

  it('draws the best lap of each day on the chosen track only (times of different tracks are not comparable)', () => {
    const imolaRows = carProgress({ bestPerDay, lapsPerDay: days }, 't2');
    expect(imolaRows.map((row) => [row.day, row.bestS, row.lapId])).toEqual([['2026-11-03', 95, 'b'], ['2026-11-05', 94.5, 'c'], ['2026-11-09', null, null]]);
    expect(carProgress({ bestPerDay, lapsPerDay: days }, 't1').map((row) => row.bestS)).toEqual([140, null, 139]);
    expect(bestRange(imolaRows)).not.toBeNull();
    expect(bestRange(carProgress({ bestPerDay, lapsPerDay: days }))).toBeNull();
  });

  it('lists the tracks with a daily best, the one with the most days first', () => {
    expect(carProgressTracks({ bestPerDay, lapsPerDay: days })).toEqual([imola, spa]); // two days each: by name
    expect(carProgressTracks({ bestPerDay: [...bestPerDay, { day: '2026-11-10', bestMs: 138_000, lapId: 'e', track: spa }], lapsPerDay: days })).toEqual([spa, imola]); // three days beat two
    expect(carProgressTracks({ bestPerDay: [], lapsPerDay: days })).toEqual([]);
  });
});
