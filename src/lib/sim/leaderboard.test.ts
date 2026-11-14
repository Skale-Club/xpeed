import { describe, expect, it } from 'vitest';
import { formatSeconds, gapShare, podiumOf, podiumStage, spreadOf, standingOf } from '@/lib/sim/leaderboard';
import { thumbPath } from '@/lib/sim/track-thumb';
import type { LeaderboardEntry } from '@/lib/sim/social-client';

const entry = (rank: number, timeMs: number, over: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  rank, lapId: `lap-${rank}-${timeMs}`, handle: `driver_${rank}`, displayName: null, timeMs, gapMs: 0, achievedAt: '2026-11-10T12:00:00.000Z', isMe: false, ...over,
});
const board = (times: number[]) => times.map((time, i) => entry(times.findIndex((other) => other === time) + 1, time, { gapMs: time - times[0], lapId: `lap-${i}` }));

describe('the podium', () => {
  it('is the first three rows, and stands second, first, third', () => {
    const rows = board([100, 110, 120, 130]);
    expect(podiumOf(rows).map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(podiumStage(podiumOf(rows)).map((row) => row.rank)).toEqual([2, 1, 3]);
  });

  it('lets a tie share a step (1, 2, 2) and keeps the rank order when fewer than three drive', () => {
    expect(podiumStage(podiumOf(board([100, 110, 110, 130]))).map((row) => row.rank)).toEqual([2, 1, 2]);
    expect(podiumStage(podiumOf(board([100, 110]))).map((row) => row.rank)).toEqual([1, 2]);
    expect(podiumOf([])).toEqual([]);
  });
});

describe('where a person stands', () => {
  const rows = board([99_000, 99_150, 99_150, 99_450, 100_650]);

  it('is in the field: the gap to the leader and to third place', () => {
    const me = rows[4];
    expect(standingOf(me, 25, rows)).toEqual({ kind: 'field', rank: 5, total: 25, gapToLeaderMs: 1650, gapToPodiumMs: 1500, leadOverNextMs: null });
  });

  it('is on the podium: no gap to the podium', () => {
    expect(standingOf(rows[2], 5, rows)).toMatchObject({ kind: 'podium', gapToPodiumMs: null, gapToLeaderMs: 150 });
  });

  it('leads: how far ahead of the next driver, and nothing when tied for the lead with nobody slower', () => {
    expect(standingOf(rows[0], 5, rows)).toMatchObject({ kind: 'leader', gapToLeaderMs: 0, leadOverNextMs: 150 });
    const alone = [entry(1, 90_000, { isMe: true })];
    expect(standingOf(alone[0], 1, alone).leadOverNextMs).toBeNull();
  });

  it('does not invent a gap to the podium when third place is not known', () => {
    expect(standingOf(entry(7, 100_000, { gapMs: 1000 }), 9, [entry(1, 99_000)]).gapToPodiumMs).toBeNull();
  });
});

describe('gaps in a sentence', () => {
  it('has three decimals under a second, two up to a minute and minutes beyond, with the decimal mark of the language', () => {
    expect(formatSeconds(412, 'en')).toBe('0.412');
    expect(formatSeconds(1900, 'en')).toBe('1.90');
    expect(formatSeconds(1900, 'pt-BR')).toBe('1,90');
    expect(formatSeconds(65_200, 'en')).toBe('1:05.2');
    expect(formatSeconds(-5, 'en')).toBe('0.000');
  });
});

describe('the bars', () => {
  it('scales a gap to the widest one, and draws nothing for a leader or when there is nothing to scale against', () => {
    expect(gapShare(0, 2000)).toBe(0);
    expect(gapShare(500, 2000)).toBe(0.25);
    expect(gapShare(2000, 2000)).toBe(1);
    expect(gapShare(3000, 2000)).toBe(1);
    expect(gapShare(500, 0)).toBe(0);
    expect(gapShare(Number.NaN, 100)).toBe(0);
  });

  it('puts every known time on one line from the fastest to the slowest, with you marked and the end of the podium', () => {
    const rows = board([100_000, 101_000, 102_000, 103_000, 110_000]);
    const spread = spreadOf(rows.slice(0, 4), [{ ...rows[4], isMe: true }])!;
    expect(spread.fastestMs).toBe(100_000);
    expect(spread.slowestMs).toBe(110_000);
    expect(spread.dots.map((dot) => dot.at)).toEqual([0, 0.1, 0.2, 0.3, 1]);
    expect(spread.dots.filter((dot) => dot.isMe)).toHaveLength(1);
    expect(spread.podiumAt).toBe(0.2);
  });

  it('says nothing about a field of one, and never divides by zero when everybody is level', () => {
    expect(spreadOf([entry(1, 100_000)])).toBeNull();
    const level = spreadOf([entry(1, 100_000, { lapId: 'a' }), entry(1, 100_000, { lapId: 'b' })])!;
    expect(level.dots.map((dot) => dot.at)).toEqual([0, 0]);
  });
});

describe('the outline of a circuit', () => {
  it('scales to fit the square, keeps the shape and closes a closed track', () => {
    const path = thumbPath([0, 100, 100, 0], [0, 0, 50, 50], { size: 100, pad: 10, closed: true });
    expect(path.d).toBe('M10.0 30.0 L90.0 30.0 L90.0 70.0 L10.0 70.0 Z');
    expect(path.points).toBe(4);
  });

  it('skips points that are not numbers, thins a long line, and draws nothing for fewer than two points or one place', () => {
    expect(thumbPath([0, Number.NaN, 10], [0, 5, 10]).points).toBe(2);
    const many = Array.from({ length: 1000 }, (_, i) => i);
    expect(thumbPath(many, many, { maxPoints: 100 }).points).toBeLessThanOrEqual(101);
    expect(thumbPath([1], [1]).d).toBe('');
    expect(thumbPath([5, 5], [5, 5]).d).toBe('');
  });
});
