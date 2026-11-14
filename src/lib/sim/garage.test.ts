import { describe, expect, it } from 'vitest';
import { ref, v1Lap } from '@/test/v1-fake-server';
import {
  carBoard, consistencyByTrack, formatSector, formatTimeDriven, lapsPerDaySeries, matchesSearch, mostDrivenTrack, normalizeName, pbByTrack, pbTrend, progressFromLaps, progressShape,
  runningBest, sectorBests, signedSeconds, sortListed, summarizeLaps, timeSparkPath, trackRows, validPercent, type TrackBestCar,
} from './garage';

const item = (name: string, lapCount: number, lastDrivenAt: string) => ({ name, lapCount, lastDrivenAt });

describe('search', () => {
  it('ignores case, accents and punctuation, and wants every word of the query', () => {
    expect(normalizeName('Nürburgring Nordschleife')).toBe('nurburgring nordschleife');
    expect(matchesSearch('Nürburgring Nordschleife', 'nurburg')).toBe(true);
    expect(matchesSearch('Spa-Francorchamps', 'spa francorchamps')).toBe(true);
    expect(matchesSearch('Spa-Francorchamps', 'francor spa')).toBe(true);
    expect(matchesSearch('Spa-Francorchamps', 'monza')).toBe(false);
    expect(matchesSearch('Monza', '   ')).toBe(true);
    expect(matchesSearch('Monza', '')).toBe(true);
  });
});

describe('sorting the lists', () => {
  const items = [item('Spa', 30, '2026-11-11T10:00:00Z'), item('Imola', 90, '2026-11-01T10:00:00Z'), item('Monza', 30, '2026-11-13T10:00:00Z'), item('Bahrain', 5, '2026-11-13T10:00:00Z')];
  it('puts the most recently driven first, and the same moment by name', () => {
    expect(sortListed(items, 'recent').map((entry) => entry.name)).toEqual(['Bahrain', 'Monza', 'Spa', 'Imola']);
  });
  it('puts the most laps first, the more recent first among equals', () => {
    expect(sortListed(items, 'most').map((entry) => entry.name)).toEqual(['Imola', 'Monza', 'Spa', 'Bahrain']);
  });
  it('sorts by name, numbers by value, and never changes the list it is given', () => {
    const before = items.map((entry) => entry.name);
    expect(sortListed([item('Track 10', 1, '2026-11-01T00:00:00Z'), item('Track 2', 1, '2026-11-01T00:00:00Z')], 'az').map((entry) => entry.name)).toEqual(['Track 2', 'Track 10']);
    expect(sortListed(items, 'az').map((entry) => entry.name)).toEqual(['Bahrain', 'Imola', 'Monza', 'Spa']);
    expect(items.map((entry) => entry.name)).toEqual(before);
  });
  it('does not break on a date it cannot read', () => {
    expect(sortListed([item('A', 1, 'nope'), item('B', 1, '2026-11-01T00:00:00Z')], 'recent').map((entry) => entry.name)).toEqual(['B', 'A']);
  });
});

describe('the trend of a personal best', () => {
  const today = '2026-11-13';
  it('is faster when a lap in the last 30 days beat the best of 30 days ago', () => {
    const trend = pbTrend([{ day: '2026-09-01', bestMs: 101_000 }, { day: '2026-10-01', bestMs: 100_500 }, { day: '2026-11-10', bestMs: 99_800 }], today);
    expect(trend).toEqual({ kind: 'faster', bestMs: 99_800, priorMs: 100_500, gainMs: 700 });
  });
  it('is steady when nothing in the last 30 days was faster', () => {
    const trend = pbTrend([{ day: '2026-09-01', bestMs: 99_000 }, { day: '2026-11-10', bestMs: 100_000 }], today);
    expect(trend.kind).toBe('steady');
    expect(trend.gainMs).toBeNull();
  });
  it('is "first" when the first valid lap came within the last 30 days', () => {
    expect(pbTrend([{ day: '2026-11-01', bestMs: 99_000 }], today)).toEqual({ kind: 'first', bestMs: 99_000, priorMs: null, gainMs: null });
  });
  it('counts the day exactly 30 days ago as before, and the day after as within', () => {
    expect(pbTrend([{ day: '2026-10-15', bestMs: 99_000 }], today).kind).toBe('first');
    expect(pbTrend([{ day: '2026-10-14', bestMs: 99_000 }], today).kind).toBe('steady');
  });
  it('is none with no valid lap, and ignores times that are not numbers above zero', () => {
    expect(pbTrend([], today).kind).toBe('none');
    expect(pbTrend([{ day: '2026-10-01', bestMs: Number.NaN }, { day: '2026-10-02', bestMs: 0 }], today).kind).toBe('none');
  });
});

describe('the best so far', () => {
  it('is the running minimum, oldest day first, whatever order the days come in', () => {
    expect(runningBest([{ day: '2026-11-03', bestMs: 99_000 }, { day: '2026-11-01', bestMs: 101_000 }, { day: '2026-11-02', bestMs: 102_000 }])).toEqual([101_000, 101_000, 99_000]);
    expect(runningBest([])).toEqual([]);
  });
});

describe('the lap-time sparkline', () => {
  it('draws nothing for no points and a dot for one', () => {
    expect(timeSparkPath([], 96, 28)).toEqual({ d: '', last: null, points: 0 });
    const one = timeSparkPath([100_000], 96, 28);
    expect(one.d).toBe('');
    expect(one.last).toEqual({ x: 48, y: 14 });
    expect(one.points).toBe(1);
  });
  it('is a line across the middle when every value is the same', () => {
    const flat = timeSparkPath([100_000, 100_000, 100_000], 96, 28);
    expect(flat.d).toBe('M2 14 L48 14 L94 14');
  });
  it('puts a faster lap lower, on the scale of the series itself', () => {
    const path = timeSparkPath([102_000, 101_000, 100_000], 96, 28);
    const ys = [...path.d.matchAll(/ (\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
    expect(ys[0]).toBeLessThan(ys[2]);
    expect(Math.min(...ys)).toBe(2);
    expect(Math.max(...ys)).toBe(26);
  });
  it('never writes NaN or Infinity', () => {
    const path = timeSparkPath([Number.NaN, 100_000, Infinity, -5, 99_000], 96, 28);
    expect(path.d).not.toMatch(/NaN|Infinity/);
    expect(path.points).toBe(2);
  });
});

describe('laps per day', () => {
  it('is one value per day of the last 30 days ending today, zero where nothing was driven', () => {
    const series = lapsPerDaySeries([{ day: '2026-11-13', laps: 4 }, { day: '2026-11-11', laps: 2 }, { day: '2026-09-01', laps: 9 }], '2026-11-13', 30);
    expect(series).toHaveLength(30);
    expect(series[29]).toBe(4);
    expect(series[27]).toBe(2);
    expect(series.reduce((total, value) => total + value, 0)).toBe(6);
  });
});

describe('lap times as text', () => {
  it('signs the gap and keeps three decimals', () => {
    expect(signedSeconds(412)).toBe('+0.412');
    expect(signedSeconds(-1500)).toBe('-1.500');
    expect(signedSeconds(0)).toBe('0.000');
    expect(signedSeconds(Number.NaN)).toBe('0.000');
  });
  it('writes a sector under and over a minute', () => {
    expect(formatSector(31_412)).toBe('31.412');
    expect(formatSector(65_412)).toBe('1:05.412');
    expect(formatSector(0)).toBe('–');
    expect(formatSector(Number.NaN)).toBe('–');
  });
  it('writes the time at the wheel with seconds under an hour and hours and minutes from one', () => {
    expect(formatTimeDriven(154_252, 'en')).toBe('2m 34s');
    expect(formatTimeDriven(120_000, 'en')).toBe('2m');
    expect(formatTimeDriven(45_000, 'en')).toBe('45s');
    expect(formatTimeDriven(4_500_000, 'en')).toBe('1h 15m');
    expect(formatTimeDriven(0, 'en')).toBe('0s');
    expect(formatTimeDriven(Number.NaN, 'en')).toBe('0s');
  });
  it('gives a share of valid laps only when there are laps', () => {
    expect(validPercent(5, 4)).toBe(80);
    expect(validPercent(0, 0)).toBeNull();
    expect(validPercent(1, 0)).toBe(0);
  });
});

describe('what the lap list adds', () => {
  const monza = ref('Monza');
  const spa = ref('Spa');
  const lap = (timeMs: number, extra: Parameters<typeof v1Lap>[0] = {}) => v1Lap({ track: monza, timeMs, ...extra });

  it('adds up the time and averages the valid laps without in and out laps', () => {
    const summary = summarizeLaps([lap(100_000), lap(102_000), lap(90_000, { valid: false }), lap(120_000, { outLap: true }), lap(0)]);
    expect(summary.timeMs).toBe(100_000 + 102_000 + 90_000 + 120_000);
    expect(summary.averageValidMs).toBe(101_000);
  });
  it('has no average with no valid lap (the one lap of an account the game did not count)', () => {
    const summary = summarizeLaps([lap(154_252, { valid: false })]);
    expect(summary).toEqual({ timeMs: 154_252, averageValidMs: null });
    expect(summarizeLaps([])).toEqual({ timeMs: 0, averageValidMs: null });
  });
  it('measures the spread of the clean laps on each track, the most laps first, and wants three of them', () => {
    const rows = consistencyByTrack([
      lap(100_000), lap(101_000), lap(102_000), lap(99_000, { valid: false }), lap(130_000, { inLap: true }),
      v1Lap({ track: spa, timeMs: 134_000 }), v1Lap({ track: spa, timeMs: 135_000 }),
    ]);
    expect(rows.map((row) => [row.track.name, row.laps, row.spreadMs, row.bestMs, row.averageMs])).toEqual([['Monza', 3, 1000, 100_000, 101_000], ['Spa', 2, null, 134_000, 134_500]]);
  });
  it('leaves out a track with no clean lap', () => {
    expect(consistencyByTrack([lap(150_000, { valid: false })])).toEqual([]);
  });
  it('builds the rows of a progress chart from the laps: the best valid lap of each day, the laps of the day, one car on request', () => {
    const a = ref('Ferrari');
    const b = ref('Toyota');
    const laps = [
      lap(101_000, { car: a, startedAt: '2026-11-10T10:00:00.000Z' }), lap(99_000, { car: a, startedAt: '2026-11-10T10:05:00.000Z' }), lap(98_000, { car: a, valid: false, startedAt: '2026-11-10T10:08:00.000Z' }),
      lap(100_000, { car: b, startedAt: '2026-11-12T10:00:00.000Z' }),
    ];
    expect(progressFromLaps(laps).map((row) => [row.day, row.bestS, row.laps, row.validLaps, row.car])).toEqual([['2026-11-10', 99, 3, 2, 'Ferrari'], ['2026-11-12', 100, 1, 1, 'Toyota']]);
    expect(progressFromLaps(laps, b.id).map((row) => [row.day, row.bestS, row.laps])).toEqual([['2026-11-12', 100, 1]]);
    expect(progressFromLaps([], null)).toEqual([]);
  });
  it('says how many days a chart has and where its line starts and ends', () => {
    const rows = progressFromLaps([lap(101_000, { startedAt: '2026-11-10T10:00:00.000Z' }), lap(100_000, { startedAt: '2026-11-11T10:00:00.000Z' }), lap(150_000, { valid: false, startedAt: '2026-11-12T10:00:00.000Z' })]);
    const shape = progressShape(rows);
    expect(shape.days).toBe(3);
    expect(shape.bestPoints).toBe(2);
    expect(shape.best?.day).toBe('2026-11-11');
    expect(shape.first?.day).toBe('2026-11-10');
    expect(shape.last?.day).toBe('2026-11-11');
    expect(progressShape([]).best).toBeNull();
  });
});

describe('the board of cars on a track', () => {
  const car = (name: string, bestMs: number | null, extra: Partial<TrackBestCar> = {}): TrackBestCar => ({ car: { id: name, name, class: null }, lapCount: 3, validLapCount: bestMs === null ? 0 : 3, bestMs, lapId: bestMs === null ? null : `lap-${name}`, achievedAt: '2026-11-10T10:00:00.000Z', ...extra });

  it('ranks the cars by their best lap with the gap to the fastest, ties sharing a rank, and the cars with no valid lap last', () => {
    const board = carBoard([car('Untimed', null), car('Slow', 101_000), car('Fast', 99_000), car('Tied', 101_000)]);
    expect(board.map((row) => [row.car.name, row.rank, row.deltaMs, row.bestMs])).toEqual([['Fast', 1, 0, 99_000], ['Slow', 2, 2000, 101_000], ['Tied', 2, 2000, 101_000], ['Untimed', null, null, null]]);
  });
  it('is empty with no cars and has no fastest gap when no car has a valid lap', () => {
    expect(carBoard([])).toEqual([]);
    expect(carBoard([car('A', null)])[0]).toMatchObject({ rank: null, deltaMs: null, bestMs: null });
  });

  it('takes the best of each sector over all the cars and adds them up to the theoretical lap', () => {
    const result = sectorBests([
      car('A', 99_000, { bestSectorsMs: [31_000, 36_000, 32_000], sectorLapIds: ['a1', 'a2', 'a3'] }),
      car('B', 100_000, { bestSectorsMs: [30_500, 36_500, 33_000], sectorLapIds: ['b1', 'b2', 'b3'] }),
    ], 99_000);
    expect(result?.sectors.map((sector) => [sector.index, sector.ms, sector.carName, sector.lapId])).toEqual([[0, 30_500, 'B', 'b1'], [1, 36_000, 'A', 'a2'], [2, 32_000, 'A', 'a3']]);
    expect(result?.theoreticalMs).toBe(98_500);
    expect(result?.gainMs).toBe(500);
  });
  it('leaves out a car whose sectors are split another way, and says nothing without sector times', () => {
    const result = sectorBests([car('A', 99_000, { bestSectorsMs: [31_000, 36_000, 32_000] }), car('B', 98_000, { bestSectorsMs: [49_000, 49_000] }), car('C', 99_500, { bestSectorsMs: [31_500, 36_500, 31_000] })], 98_000);
    expect(result?.sectors).toHaveLength(3);
    expect(result?.sectors.map((sector) => sector.carName)).toEqual(['A', 'A', 'C']);
    expect(sectorBests([car('A', 99_000), car('B', 99_000, { bestSectorsMs: null })], 99_000)).toBeNull();
    expect(sectorBests([car('A', 99_000, { bestSectorsMs: [1000, Number.NaN] })], 99_000)).toBeNull();
    expect(sectorBests([], null)).toBeNull();
  });
  it('has no gain without a best lap and never a negative one', () => {
    expect(sectorBests([car('A', null, { bestSectorsMs: [30_000, 30_000] })], null)?.gainMs).toBeNull();
    expect(sectorBests([car('A', 50_000, { bestSectorsMs: [30_000, 30_000] })], 50_000)?.gainMs).toBe(0);
  });
});

describe('the best lap on each track with a car', () => {
  const entry = (name: string, lapCount: number, bestMs: number | null) => ({ track: ref(name, `id-${name}`), lapCount, validLapCount: lapCount, bestMs, lapId: bestMs === null ? null : `lap-${name}`, achievedAt: '2026-11-10T10:00:00.000Z' });

  it('takes the best lap of each track over every car you drove there', () => {
    const best = pbByTrack([
      { track: ref('Monza', 'monza'), bestMs: 100_000 }, { track: ref('Monza', 'monza'), bestMs: 99_000 }, { track: ref('Spa', 'spa'), bestMs: 135_000 }, { track: ref('Imola', 'imola'), bestMs: Number.NaN },
    ]);
    expect([...best]).toEqual([['monza', 99_000], ['spa', 135_000]]);
  });
  it('gives the gap to that best: zero when this car holds it, nothing when it is not known; the most driven track first', () => {
    const rows = trackRows([entry('Spa', 2, 136_000), entry('Monza', 9, 99_500), entry('Imola', 1, null)], new Map([['id-Spa', 135_000], ['id-Monza', 99_500]]));
    expect(rows.map((row) => [row.track.name, row.deltaToPbMs])).toEqual([['Monza', 0], ['Spa', 1000], ['Imola', null]]);
    expect(mostDrivenTrack(rows)?.track.name).toBe('Monza');
    expect(trackRows([entry('Spa', 2, 136_000)], null)[0].deltaToPbMs).toBeNull();
    expect(mostDrivenTrack([])).toBeNull();
  });
});
