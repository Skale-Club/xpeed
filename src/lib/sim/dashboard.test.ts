import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activityOf, bucketSeries, buildKpis, changeOf, cleanShare, dailySeries, daysBetween, formatDistance, formatDuration, heatmapGrid, loadRange, pairRange, percentChange,
  rangeStorageKey, saveRange, sparklinePath, spreadSentence, streakText, validShare,
} from '@/lib/sim/dashboard';
import en from '@/locales/en.json';
import esES from '@/locales/es-ES.json';
import ptBR from '@/locales/pt-BR.json';
import { computeStats } from '@/test/v1-fake-server';
import { dashboardState, NOW, oneInvalidLapState } from '@/test/dashboard-fixture';
import type { V1Stats, V1StatsDay } from '@/lib/sim/v1-client';

const day = (over: Partial<V1StatsDay> & { day: string }): V1StatsDay => ({ laps: 0, validLaps: 0, timeMs: 0, distanceM: 0, sessions: 0, personalBests: 0, tracks: 0, cars: 0, ...over });

describe('percent change', () => {
  it('is the change from the previous period to this one in whole percent', () => {
    expect(percentChange(120, 100)).toBe(20);
    expect(percentChange(80, 100)).toBe(-20);
    expect(percentChange(100, 100)).toBe(0);
    expect(percentChange(1, 3)).toBe(-67);
    expect(percentChange(0, 50)).toBe(-100);
  });

  it('is null when the previous period is empty, so the tile says n/a and never "Infinity%" or NaN', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(5, Number.NaN)).toBeNull();
    expect(percentChange(Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(percentChange(5, -3)).toBeNull();
  });

  it('is a neutral direction: up, down or the same (to the whole percent), none when there is nothing to compare', () => {
    expect(changeOf(120, 100)).toEqual({ trend: 'up', percent: 20 });
    expect(changeOf(80, 100)).toEqual({ trend: 'down', percent: 20 });
    expect(changeOf(1001, 1000)).toEqual({ trend: 'same', percent: 0 });
    expect(changeOf(7, 0)).toEqual({ trend: 'none', percent: null });
  });
});

describe('days and series', () => {
  it('lists every UTC day of a range, both ends included, and nothing for a wrong range', () => {
    expect(daysBetween('2026-11-01', '2026-11-04')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(daysBetween('2026-11-04', '2026-11-04')).toEqual(['2026-11-04']);
    expect(daysBetween('2026-11-05', '2026-11-04')).toEqual([]);
    expect(daysBetween('nope', '2026-11-04')).toEqual([]);
    expect(daysBetween('2026-02-27', '2026-03-02')).toHaveLength(4);
  });

  it('gives one value per day, zero on days without laps', () => {
    const perDay = [day({ day: '2026-11-02', laps: 4 }), day({ day: '2026-11-04', laps: 1 })];
    expect(dailySeries(perDay, '2026-11-01', '2026-11-05', (entry) => entry.laps)).toEqual([0, 4, 0, 1, 0]);
    expect(dailySeries([], '2026-11-01', '2026-11-03', (entry) => entry.laps)).toEqual([0, 0, 0]);
    expect(dailySeries(perDay, '2026-11-01', '2026-11-05', () => Number.NaN)).toEqual([0, 0, 0, 0, 0]);
  });

  it('adds neighbours together until a series has at most the points asked for', () => {
    expect(bucketSeries([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(bucketSeries([1, 1, 1, 1, 1, 1], 3)).toEqual([2, 2, 2]);
    expect(bucketSeries(Array.from({ length: 365 }, () => 1), 40).length).toBeLessThanOrEqual(40);
    expect(bucketSeries(Array.from({ length: 365 }, () => 1), 40).reduce((a, b) => a + b, 0)).toBe(365);
    expect(bucketSeries([1, 2], 0)).toEqual([]);
  });
});

describe('sparkline path', () => {
  it('draws nothing for no points', () => {
    expect(sparklinePath([], 100, 20)).toEqual({ d: '', last: null, points: 0 });
  });

  it('is a dot in the middle, and no line, for one point', () => {
    const one = sparklinePath([7], 100, 20);
    expect(one.d).toBe('');
    expect(one.points).toBe(1);
    expect(one.last).toEqual({ x: 50, y: 2 });
  });

  it('is a line from the first to the last point for many, on a scale that starts at zero', () => {
    const many = sparklinePath([0, 5, 10], 100, 22, 2);
    expect(many.d).toBe('M2 20 L50 11 L98 2');
    expect(many.last).toEqual({ x: 98, y: 2 });
    expect(many.points).toBe(3);
  });

  it('is a flat line along the bottom for zeros, and never holds NaN or Infinity', () => {
    expect(sparklinePath([0, 0, 0], 100, 20).d).toBe('M2 18 L50 18 L98 18');
    const messy = sparklinePath([Number.NaN, Number.POSITIVE_INFINITY, -4, 3], 100, 20);
    expect(messy.d).not.toMatch(/NaN|Infinity/);
    expect(messy.points).toBe(4);
    const flat = sparklinePath([5, 5, 5], 100, 20);
    expect(flat.d).toBe('M2 2 L50 2 L98 2');
  });
});

describe('the heatmap grid', () => {
  // 2026-11-13 is a Friday.
  const today = '2026-11-13';

  it('has weeks as columns, Monday first, seven rows each, ending with the week of today', () => {
    const grid = heatmapGrid([], today);
    expect(grid.weeks.length).toBeGreaterThanOrEqual(52);
    expect(grid.weeks.length).toBeLessThanOrEqual(54);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    const lastWeek = grid.weeks[grid.weeks.length - 1];
    expect(lastWeek[0]?.day).toBe('2026-11-09');
    expect(lastWeek[4]?.day).toBe(today);
    expect(lastWeek[5]).toBeNull();
    expect(lastWeek[6]).toBeNull();
    const first = grid.weeks[0].find((cell) => cell !== null);
    expect(first?.day).toBe('2025-11-14');
  });

  it('puts every day once, in order', () => {
    const cells = heatmapGrid([], today).weeks.flat().filter((cell) => cell !== null).map((cell) => cell!.day);
    expect(cells).toHaveLength(365);
    expect(cells).toEqual([...cells].sort());
    expect(new Set(cells).size).toBe(365);
  });

  it('gives intensity by laps: none for no laps, 1 to 4 for the quiet to the busiest days', () => {
    const grid = heatmapGrid([{ day: '2026-11-13', laps: 40 }, { day: '2026-11-12', laps: 1 }, { day: '2026-11-11', laps: 20 }, { day: '2026-11-10', laps: 11 }], today);
    const byDay = new Map(grid.weeks.flat().filter((cell) => cell !== null).map((cell) => [cell!.day, cell!]));
    expect(byDay.get('2026-11-13')?.level).toBe(4);
    expect(byDay.get('2026-11-12')?.level).toBe(1);
    expect(byDay.get('2026-11-11')?.level).toBe(2);
    expect(byDay.get('2026-11-10')?.level).toBe(2);
    expect(byDay.get('2026-11-09')?.level).toBe(0);
    expect(grid.max).toBe(40);
    expect(grid.active).toBe(4);
    expect(grid.total).toBe(72);
  });

  it('names the months where a new one starts, and survives bad input', () => {
    const grid = heatmapGrid([], today);
    expect(grid.months.length).toBeGreaterThanOrEqual(11);
    expect(new Set(grid.months.map((month) => month.col)).size).toBe(grid.months.length);
    expect(grid.months.every((month) => month.month >= 0 && month.month <= 11)).toBe(true);
    expect(heatmapGrid([{ day: '2026-11-13', laps: Number.NaN }, { day: 'bad', laps: 3 }], today).max).toBe(0);
    expect(heatmapGrid([], 'nope')).toEqual({ weeks: [], months: [], max: 0, active: 0, total: 0 });
  });
});

describe('streak text', () => {
  it('says the current streak with a count (the plural is the locale file\'s job)', () => {
    expect(streakText({ current: 3, best: 3 })).toEqual({ current: { key: 'modes.overview.dash.streakCurrent', values: { count: 3 } }, best: null });
    expect(streakText({ current: 1, best: 1 }).current.values).toEqual({ count: 1 });
  });

  it('says there is no streak at 0, and the longest one only when it is longer than the current', () => {
    expect(streakText({ current: 0, best: 0 })).toEqual({ current: { key: 'modes.overview.dash.streakNone', values: {} }, best: null });
    expect(streakText({ current: 1, best: 5 }).best).toEqual({ key: 'modes.overview.dash.streakBest', values: { count: 5 } });
    expect(streakText({ current: 0, best: 1 }).best).toBeNull();
    expect(streakText({ current: 4, best: 4 }).best).toBeNull();
  });
});

describe('the consistency sentence', () => {
  it('is null when no session has a spread', () => {
    expect(spreadSentence([])).toBeNull();
    expect(spreadSentence([{ spreadMs: null }, { spreadMs: null }])).toBeNull();
  });

  it('says the spread alone when it is the only one so far', () => {
    expect(spreadSentence([{ spreadMs: null }, { spreadMs: 312 }])).toEqual({ key: 'modes.overview.dash.spreadOnly', values: { spread: '0.31' } });
  });

  it('compares the recent half with the sessions before: "0.31 s, 12% tighter than before"', () => {
    expect(spreadSentence([{ spreadMs: 352 }, { spreadMs: 310 }])).toEqual({ key: 'modes.overview.dash.spreadTighter', values: { spread: '0.31', percent: 12 } });
    expect(spreadSentence([{ spreadMs: 400 }, { spreadMs: 400 }, { spreadMs: 300 }, { spreadMs: 300 }])).toEqual({ key: 'modes.overview.dash.spreadTighter', values: { spread: '0.30', percent: 25 } });
  });

  it('says looser, and about the same under 1%, each with its own key', () => {
    expect(spreadSentence([{ spreadMs: 200 }, { spreadMs: 300 }])).toEqual({ key: 'modes.overview.dash.spreadLooser', values: { spread: '0.30', percent: 50 } });
    expect(spreadSentence([{ spreadMs: 1000 }, { spreadMs: 1005 }])?.key).toBe('modes.overview.dash.spreadSame');
  });

  it('never builds a number from nothing: a spread of zero before is the same, a bad value is skipped', () => {
    expect(spreadSentence([{ spreadMs: 0 }, { spreadMs: 100 }])?.key).toBe('modes.overview.dash.spreadSame');
    expect(spreadSentence([{ spreadMs: Number.NaN }, { spreadMs: 250 }])).toEqual({ key: 'modes.overview.dash.spreadOnly', values: { spread: '0.25' } });
  });

  it('averages the share of clean laps over the sessions, null with none', () => {
    expect(cleanShare([{ cleanShare: 0.5 }, { cleanShare: 1 }])).toBe(75);
    expect(cleanShare([])).toBeNull();
    expect(cleanShare([{ cleanShare: 0 }])).toBe(0);
  });
});

describe('the sentences are in the three languages', () => {
  const lookup = (tree: unknown, path: string): unknown => path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
  const keys = [
    streakText({ current: 2, best: 5 }).current.key, streakText({ current: 0, best: 0 }).current.key, streakText({ current: 1, best: 5 }).best!.key,
    spreadSentence([{ spreadMs: 300 }])!.key, spreadSentence([{ spreadMs: 400 }, { spreadMs: 300 }])!.key, spreadSentence([{ spreadMs: 300 }, { spreadMs: 400 }])!.key, spreadSentence([{ spreadMs: 300 }, { spreadMs: 300 }])!.key,
  ];

  it.each([['en', en], ['pt-BR', ptBR], ['es-ES', esES]])('%s has every key a sentence can name (a plural has both forms) with the values it is given', (_name, locale) => {
    for (const key of keys) {
      const direct = lookup(locale, key);
      const plural = [lookup(locale, `${key}_one`), lookup(locale, `${key}_other`)];
      expect(typeof direct === 'string' || plural.every((form) => typeof form === 'string'), key).toBe(true);
    }
    for (const key of ['spreadTighter', 'spreadLooser']) {
      const text = lookup(locale, `modes.overview.dash.${key}`) as string;
      expect(text).toContain('{{spread}}');
      expect(text).toContain('{{percent}}');
    }
  });
});

describe('units', () => {
  it('writes a time driven as hours and minutes, minutes, or seconds', () => {
    expect(formatDuration(0, 'en')).toMatch(/^0\s?s/);
    expect(formatDuration(45_000, 'en')).toMatch(/^45\s?s/);
    expect(formatDuration(25 * 60_000, 'en')).toMatch(/^25\s?m/);
    expect(formatDuration((4 * 60 + 12) * 60_000, 'en')).toMatch(/^4\s?h\s+12\s?m/);
    expect(formatDuration(3 * 3_600_000, 'en')).toMatch(/^3\s?h$/);
    expect(formatDuration(Number.NaN, 'en')).toMatch(/^0/);
  });

  it('writes a distance in the person\'s unit', () => {
    expect(formatDistance(58_000, 'km', 'en')).toBe('58 km');
    expect(formatDistance(16_093.44, 'mi', 'en')).toBe('10 mi');
    expect(formatDistance(250_000, 'km', 'en')).toBe('250 km');
    expect(formatDistance(0, 'km', 'en')).toBe('0 km');
    expect(formatDistance(Number.NaN, 'mi', 'en')).toBe('0 mi');
  });

  it('shares valid laps in whole percent, null with no laps', () => {
    expect(validShare({ laps: 8, validLaps: 7 })).toBe(88);
    expect(validShare({ laps: 1, validLaps: 0 })).toBe(0);
    expect(validShare({ laps: 0, validLaps: 0 })).toBeNull();
  });
});

describe('the tiles, the activity and the small multiples of a real answer', () => {
  const stats = (): V1Stats => computeStats(dashboardState(), '30d', new Date(NOW));

  it('builds six tiles, each with the change against the period before and a series of at most 40 points', () => {
    const kpis = buildKpis(stats());
    expect(kpis.map((kpi) => kpi.id)).toEqual(['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars']);
    const laps = kpis[0];
    expect(laps.current).toBe(stats().totals.laps);
    expect(laps.previous).toBe(stats().previous.laps);
    expect(laps.change.trend).toBe('up');
    expect(kpis.every((kpi) => kpi.series.length <= 40 && kpi.series.every(Number.isFinite))).toBe(true);
    expect(kpis[0].series.reduce((a, b) => a + b, 0)).toBe(laps.current);
  });

  it('says "none" for every tile when the period before is empty (the "all" range)', () => {
    const kpis = buildKpis(computeStats(dashboardState(), 'all', new Date(NOW)));
    expect(kpis.every((kpi) => kpi.change.trend === 'none')).toBe(true);
  });

  it('reads laps per day for 120 days or less, per week above, and finds the busiest bar', () => {
    const month = activityOf(stats());
    expect(month.unit).toBe('day');
    expect(month.points).toHaveLength(30);
    expect(month.total).toBe(stats().totals.laps);
    expect(month.busiest).toMatchObject({ start: '2026-11-12', laps: 8 });
    const year = activityOf(computeStats(dashboardState(), '1y', new Date(NOW)));
    expect(year.unit).toBe('week');
    expect(year.points.length).toBeLessThanOrEqual(53);
    expect(year.total).toBe(computeStats(dashboardState(), '1y', new Date(NOW)).totals.laps);
  });

  it('has no busiest bar and no NaN when there are no laps', () => {
    const empty = activityOf({ perDay: [], range: { key: '7d', from: '2026-11-07', to: '2026-11-13', days: 7 } });
    expect(empty).toMatchObject({ unit: 'day', total: 0, busiest: null });
    expect(empty.points).toHaveLength(7);
  });

  it('handles the one-invalid-lap account without NaN or Infinity anywhere', () => {
    const one = computeStats(oneInvalidLapState(), '30d', new Date(NOW));
    const kpis = buildKpis(one);
    expect(one.totals).toMatchObject({ laps: 1, validLaps: 0 });
    expect(validShare(one.totals)).toBe(0);
    expect(kpis[0]).toMatchObject({ current: 1, previous: 0 });
    expect(kpis[0].change).toEqual({ trend: 'none', percent: null });
    expect(JSON.stringify([kpis, activityOf(one), spreadSentence(one.consistency)])).not.toMatch(/NaN|Infinity/);
    expect(pairRange(one.pairs[0].bestPerDay.map((entry) => entry.bestMs))).toBeNull();
  });

  it('gives the axis of a best-lap line a little room, and nothing under two days', () => {
    expect(pairRange([])).toBeNull();
    expect(pairRange([100_000])).toBeNull();
    expect(pairRange([100_000, 99_000])).toEqual({ low: 98.7, high: 100.3 });
    expect(pairRange([100_000, 100_000])).toEqual({ low: 99.7, high: 100.3 });
  });
});

describe('the range kept in the browser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('keeps one range per person, 30 days when nothing is kept or the value is not a range', () => {
    expect(loadRange('ana')).toBe('30d');
    saveRange('ana', '90d');
    saveRange('bia', '7d');
    expect(loadRange('ana')).toBe('90d');
    expect(loadRange('bia')).toBe('7d');
    expect(loadRange(null)).toBe('30d');
    localStorage.setItem(rangeStorageKey('ana'), 'forever');
    expect(loadRange('ana')).toBe('30d');
  });

  it('is just the default when storage is missing or throws, and keeping it never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadRange('ana')).toBe('30d');
    expect(() => saveRange('ana', '1y')).not.toThrow();
  });
});
