import { describe, expect, it } from 'vitest';
import {
  activeFilterCount, applyClientFilters, dayKey, dayRelation, groupByDay, hasClientFilters, lapSparkPath, needsMorePages, pbIndex, pbKey, pbStanding, periodStart, readFilters,
  singlePair, summarizeSessions, withFilter, NO_FILTERS,
} from '@/lib/sim/sessions-view';
import { ref, v1Lap, v1Session } from '@/test/v1-fake-server';
import type { V1Pb } from '@/lib/sim/v1-client';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const DAY = 86_400_000;
const monza = ref('Monza');
const spa = ref('Spa');
const ferrari = ref('Ferrari');
const session = (extra: Parameters<typeof v1Session>[0] = {}) => v1Session({ track: monza, car: ferrari, startedAt: '2026-11-12T10:00:00.000Z', endedAt: '2026-11-12T10:30:00.000Z', lapCount: 5, bestLapMs: 100_000, ...extra });

describe('readFilters and withFilter', () => {
  it('read every filter from the address, and ignore a kind or period that is not one of ours', () => {
    expect(readFilters(new URLSearchParams('game=lmu&track=t&car=c&kind=race&period=30d&valid=1'))).toEqual({ game: 'lmu', track: 't', car: 'c', kind: 'race', period: '30d', validOnly: true });
    expect(readFilters(new URLSearchParams('kind=drift&period=2d&valid=0'))).toEqual(NO_FILTERS);
    expect(readFilters(new URLSearchParams(''))).toEqual(NO_FILTERS);
  });

  it('set and take off one filter, keeping the rest of the address', () => {
    const base = new URLSearchParams('game=lmu&foo=bar');
    expect(withFilter(base, 'kind', 'race').toString()).toBe('game=lmu&foo=bar&kind=race');
    expect(withFilter(base, 'validOnly', true).get('valid')).toBe('1');
    expect(withFilter(new URLSearchParams('valid=1&kind=race'), 'validOnly', false).toString()).toBe('kind=race');
    expect(withFilter(new URLSearchParams('kind=race'), 'kind', '').toString()).toBe('');
  });

  it('start the track and the car over when the game changes (they belong to one game), and only then', () => {
    const base = new URLSearchParams('game=lmu&track=t&car=c&kind=race');
    expect(withFilter(base, 'game', 'ac').toString()).toBe('game=ac&kind=race');
    expect(withFilter(base, 'game', '').toString()).toBe('kind=race');
    expect(withFilter(base, 'kind', 'practice').get('track')).toBe('t');
  });

  it('count the filters that are on, and know which the server cannot apply', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, game: 'lmu', kind: 'race', validOnly: true })).toBe(3);
    expect(hasClientFilters({ ...NO_FILTERS, game: 'lmu', track: 't', car: 'c' })).toBe(false);
    expect(hasClientFilters({ ...NO_FILTERS, kind: 'race' })).toBe(true);
    expect(hasClientFilters({ ...NO_FILTERS, period: '7d' })).toBe(true);
    expect(hasClientFilters({ ...NO_FILTERS, validOnly: true })).toBe(true);
  });
});

describe('applyClientFilters', () => {
  const list = [
    session({ kind: 'race', startedAt: '2026-11-12T10:00:00.000Z' }),
    session({ kind: 'practice', startedAt: '2026-11-01T10:00:00.000Z', bestLapMs: null }),
    session({ kind: 'qualifying', startedAt: '2026-06-01T10:00:00.000Z' }),
    session({ kind: 'unknown', startedAt: '2026-11-10T10:00:00.000Z' }),
  ];

  it('keeps everything with no filter', () => {
    expect(applyClientFilters(list, NO_FILTERS, NOW)).toHaveLength(4);
  });

  it('keeps one kind', () => {
    expect(applyClientFilters(list, { ...NO_FILTERS, kind: 'race' }, NOW)).toEqual([list[0]]);
    expect(applyClientFilters(list, { ...NO_FILTERS, kind: 'practice' }, NOW)).toEqual([list[1]]);
  });

  it('keeps the sessions inside the period, counted back from now', () => {
    expect(applyClientFilters(list, { ...NO_FILTERS, period: '7d' }, NOW)).toEqual([list[0], list[3]]);
    expect(applyClientFilters(list, { ...NO_FILTERS, period: '30d' }, NOW)).toEqual([list[0], list[1], list[3]]);
    expect(applyClientFilters(list, { ...NO_FILTERS, period: '1y' }, NOW)).toHaveLength(4);
    expect(periodStart('90d', NOW)).toBe(NOW - 90 * DAY);
  });

  it('keeps the sessions with a valid lap when asked', () => {
    expect(applyClientFilters(list, { ...NO_FILTERS, validOnly: true }, NOW)).toEqual([list[0], list[2], list[3]]);
  });

  it('combines the filters', () => {
    expect(applyClientFilters(list, { ...NO_FILTERS, kind: 'practice', validOnly: true }, NOW)).toEqual([]);
    expect(applyClientFilters(list, { ...NO_FILTERS, kind: 'race', period: '7d', validOnly: true }, NOW)).toEqual([list[0]]);
  });
});

describe('needsMorePages', () => {
  const recent = [session({ startedAt: '2026-11-12T10:00:00.000Z' })];
  const old = [session({ startedAt: '2026-11-12T10:00:00.000Z' }), session({ startedAt: '2026-06-01T10:00:00.000Z' })];

  it('is never needed with no more pages, or with only the filters the server applies', () => {
    expect(needsMorePages({ ...NO_FILTERS, kind: 'race' }, recent, false, NOW)).toBe(false);
    expect(needsMorePages({ ...NO_FILTERS, game: 'lmu', track: 't' }, recent, true, NOW)).toBe(false);
    expect(needsMorePages(NO_FILTERS, recent, true, NOW)).toBe(false);
  });

  it('is needed for a kind or "valid only" until the last page, which the page cannot tell', () => {
    expect(needsMorePages({ ...NO_FILTERS, kind: 'race' }, old, true, NOW)).toBe(true);
    expect(needsMorePages({ ...NO_FILTERS, validOnly: true }, old, true, NOW)).toBe(true);
  });

  it('is needed for a period only until a session older than it has been read (they come newest first)', () => {
    expect(needsMorePages({ ...NO_FILTERS, period: '30d' }, recent, true, NOW)).toBe(true);
    expect(needsMorePages({ ...NO_FILTERS, period: '30d' }, old, true, NOW)).toBe(false);
    expect(needsMorePages({ ...NO_FILTERS, period: '30d' }, [], true, NOW)).toBe(true);
  });
});

describe('summarizeSessions', () => {
  it('sums the sessions, the laps and their length, and counts the tracks and cars', () => {
    const list = [
      session({ lapCount: 5, bestLapMs: 100_000, startedAt: '2026-11-12T10:00:00.000Z', endedAt: '2026-11-12T10:30:00.000Z' }),
      session({ track: spa, lapCount: 3, bestLapMs: 99_000, startedAt: '2026-11-11T10:00:00.000Z', endedAt: '2026-11-11T10:45:00.000Z' }),
      session({ lapCount: 2, bestLapMs: null, startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:15:00.000Z' }),
    ];
    expect(summarizeSessions(list)).toEqual({ sessions: 3, laps: 10, timeMs: 90 * 60_000, tracks: 2, cars: 1, bestLapMs: 99_000 });
  });

  it('says nothing is best when no session has a valid lap, and counts a session that ends before it starts as no time', () => {
    const summary = summarizeSessions([session({ bestLapMs: null, startedAt: '2026-11-12T10:30:00.000Z', endedAt: '2026-11-12T10:00:00.000Z' })]);
    expect(summary.bestLapMs).toBeNull();
    expect(summary.timeMs).toBe(0);
  });

  it('is zero for no sessions', () => {
    expect(summarizeSessions([])).toEqual({ sessions: 0, laps: 0, timeMs: 0, tracks: 0, cars: 0, bestLapMs: null });
  });

  it('knows when the filters name one track and one car', () => {
    expect(singlePair({ track: 't', car: 'c' })).toBe(true);
    expect(singlePair({ track: 't', car: '' })).toBe(false);
    expect(singlePair({ track: '', car: '' })).toBe(false);
  });
});

describe('days', () => {
  it('writes the day of a moment in a time zone (the evening in the Americas is the day before in UTC)', () => {
    const ms = Date.parse('2026-11-13T01:30:00.000Z');
    expect(dayKey(ms, 'UTC')).toBe('2026-11-13');
    expect(dayKey(ms, 'America/Sao_Paulo')).toBe('2026-11-12');
    expect(dayKey(ms, 'Pacific/Auckland')).toBe('2026-11-13');
  });

  it('falls back to the UTC day for a zone that does not exist', () => {
    expect(dayKey(Date.parse('2026-11-13T01:30:00.000Z'), 'Not/AZone')).toBe('2026-11-13');
  });

  it('groups the sessions by day, newest day first, summing the laps of each', () => {
    const list = [
      session({ startedAt: '2026-11-13T09:00:00.000Z', lapCount: 4 }),
      session({ startedAt: '2026-11-13T08:00:00.000Z', lapCount: 6 }),
      session({ startedAt: '2026-11-11T18:00:00.000Z', lapCount: 1 }),
    ];
    const groups = groupByDay(list, 'UTC');
    expect(groups.map((group) => [group.day, group.sessions.length, group.laps])).toEqual([['2026-11-13', 2, 10], ['2026-11-11', 1, 1]]);
    expect(groups[0].sessions).toEqual([list[0], list[1]]); // the order they came in is kept inside a day
  });

  it('puts a session on the day it started on in the person’s own zone', () => {
    const list = [session({ startedAt: '2026-11-13T01:30:00.000Z' }), session({ startedAt: '2026-11-12T20:00:00.000Z' })];
    expect(groupByDay(list, 'America/Sao_Paulo').map((group) => group.day)).toEqual(['2026-11-12']);
    expect(groupByDay(list, 'UTC').map((group) => group.day)).toEqual(['2026-11-13', '2026-11-12']);
  });

  it('says whether a day is today, yesterday or another day', () => {
    expect(dayRelation('2026-11-13', '2026-11-13')).toBe('today');
    expect(dayRelation('2026-11-12', '2026-11-13')).toBe('yesterday');
    expect(dayRelation('2026-11-11', '2026-11-13')).toBe('other');
    expect(dayRelation('2026-10-31', '2026-11-01')).toBe('yesterday'); // across a month
    expect(dayRelation('2026-11-14', '2026-11-13')).toBe('other');
  });
});

describe('pbStanding', () => {
  const pb = { bestMs: 99_000, achievedAt: '2026-11-12T10:10:00.000Z' };

  it('is the PB for the session whose best lap is the personal best', () => {
    expect(pbStanding({ bestLapMs: 99_000 }, pb)).toEqual({ kind: 'pb' });
    expect(pbStanding({ bestLapMs: 98_000 }, pb)).toEqual({ kind: 'pb' }); // a personal best the list has not caught up with
  });

  it('is how far behind otherwise, in ms', () => {
    expect(pbStanding({ bestLapMs: 99_412 }, pb)).toEqual({ kind: 'behind', deltaMs: 412 });
  });

  it('is nothing with no best lap or no personal best to compare with', () => {
    expect(pbStanding({ bestLapMs: null }, pb)).toEqual({ kind: 'none' });
    expect(pbStanding({ bestLapMs: 99_000 }, undefined)).toEqual({ kind: 'none' });
    expect(pbStanding({ bestLapMs: 0 }, pb)).toEqual({ kind: 'none' });
  });

  it('finds the personal best of a track and a car in the index', () => {
    const pbs = [{ game: 'lmu', track: monza, car: ferrari, bestMs: 99_000, lapId: 'l', achievedAt: pb.achievedAt, previousBestMs: null, improvedByMs: null }] as V1Pb[];
    const index = pbIndex(pbs);
    expect(index.get(pbKey(monza.id, ferrari.id))?.bestMs).toBe(99_000);
    expect(index.get(pbKey(spa.id, ferrari.id))).toBeUndefined();
  });
});

describe('lapSparkPath', () => {
  const lap = (timeMs: number, extra: Partial<ReturnType<typeof v1Lap>> = {}) => v1Lap({ timeMs, ...extra });

  it('draws nothing for no laps and a dot for one', () => {
    expect(lapSparkPath([], 100, 30)).toEqual({ d: '', best: null, points: 0 });
    const one = lapSparkPath([lap(100_000)], 100, 30);
    expect(one.d).toBe('');
    expect(one.points).toBe(1);
    expect(one.best).toEqual({ x: 50, y: 15 });
  });

  it('draws the flying laps only: not a voided lap, an out lap or an in lap', () => {
    const spark = lapSparkPath([lap(112_000, { outLap: true }), lap(100_000), lap(98_000, { valid: false }), lap(101_000), lap(108_000, { inLap: true }), lap(100_500)], 100, 30);
    expect(spark.points).toBe(3);
    expect(spark.d.split('L')).toHaveLength(3);
  });

  it('puts faster laps lower, scales a session to its own range, and marks the fastest lap', () => {
    const spark = lapSparkPath([lap(101_000), lap(100_000), lap(100_500)], 100, 30, 0);
    const ys = spark.d.split(/[ML]/).filter(Boolean).map((point) => Number(point.split(' ')[1]));
    expect(ys[0]).toBe(0); // the slowest lap is at the top
    expect(ys[1]).toBe(30); // the fastest at the bottom
    expect(ys[2]).toBe(15);
    expect(spark.best).toEqual({ x: 50, y: 30 });
  });

  it('keeps a session of near-identical laps from looking like a roller coaster (the range is at least half a second)', () => {
    const spark = lapSparkPath([lap(100_000), lap(100_010), lap(100_020)], 100, 30, 0);
    const ys = spark.d.split(/[ML]/).filter(Boolean).map((point) => Number(point.split(' ')[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
  });

  it('never holds NaN', () => {
    expect(lapSparkPath([lap(100_000), lap(100_000)], 100, 30).d).not.toMatch(/NaN|Infinity/);
  });
});
