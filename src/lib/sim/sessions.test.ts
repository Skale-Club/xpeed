import { describe, expect, it } from 'vitest';
import type { LibraryLap, LapSummary } from './library';
import { SESSION_GAP_MS, groupSessions } from './sessions';

const MIN = 60_000;
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
let counter = 0;

function lap(over: Partial<LapSummary> & { startMin?: number } = {}): LibraryLap {
  const { startMin = 0, ...rest } = over;
  const summary: LapSummary = {
    game: 'lmu', trackName: 'Sarthe', carName: 'GR010', carClass: 'Hyper', lapNumber: ++counter, timeMs: 210_000, valid: true,
    startedAt: new Date(T0 + startMin * MIN).toISOString(), sampleCount: 100, ...rest,
  };
  return { id: `ana|${counter}`, fileName: `lap-${counter}.xlap.gz`, addedAt: 0, size: 1, summary };
}

describe('grouping laps into sessions', () => {
  it('puts the laps of one run in one session, in the order they were driven', () => {
    const [a, b, c] = [lap({ startMin: 0 }), lap({ startMin: 4 }), lap({ startMin: 8 })];
    const sessions = groupSessions([c, a, b]); // handed over in any order
    expect(sessions).toHaveLength(1);
    expect(sessions[0].laps.map((l) => l.id)).toEqual([a.id, b.id, c.id]);
    expect(sessions[0]).toMatchObject({ game: 'lmu', trackName: 'Sarthe', carName: 'GR010', carClass: 'Hyper' });
  });

  it('starts a new session after a long break, but not at the limit', () => {
    const first = lap({ startMin: 0 });
    const justInTime = lap({ startMin: 3.5 + 30 }); // starts exactly SESSION_GAP_MS after the first lap ends
    const tooLate = lap({ startMin: 3.5 + 30 + 3.5 + 31 }); // 31 minutes after the previous ends
    const sessions = groupSessions([first, justInTime, tooLate]);
    expect(SESSION_GAP_MS).toBe(30 * MIN);
    expect(sessions.map((s) => s.laps.length)).toEqual([1, 2]); // newest first
  });

  it('does not mix cars, tracks or games', () => {
    const base = lap({ startMin: 0 });
    const car = lap({ startMin: 4, carName: 'Ferrari 499P' });
    const track = lap({ startMin: 8, trackName: 'Monza' });
    const game = lap({ startMin: 12, game: 'acc' });
    expect(groupSessions([base, car, track, game])).toHaveLength(4);
  });

  it('brings back together laps driven with another car in between only if the break is short', () => {
    const laps = [lap({ startMin: 0 }), lap({ startMin: 4 }), lap({ startMin: 100 }), lap({ startMin: 104 })];
    expect(groupSessions(laps).map((s) => s.laps.length)).toEqual([2, 2]);
  });

  it('lists the newest session first', () => {
    const old = lap({ startMin: 0, trackName: 'Monza' });
    const recent = lap({ startMin: 60 * 24 * 3, trackName: 'Sarthe' });
    expect(groupSessions([old, recent]).map((s) => s.trackName)).toEqual(['Sarthe', 'Monza']);
  });

  it('finds the quickest valid lap, ignoring laps that are not valid or have no time', () => {
    const slow = lap({ startMin: 0, timeMs: 215_000 });
    const quick = lap({ startMin: 4, timeMs: 208_500 });
    const cut = lap({ startMin: 8, timeMs: 200_000, valid: false });
    const untimed = lap({ startMin: 12, timeMs: 0 });
    const [session] = groupSessions([slow, quick, cut, untimed]);
    expect(session.best?.id).toBe(quick.id);
    expect(session.validCount).toBe(2);
    expect(session.laps).toHaveLength(4);
  });

  it('has no best lap when none is valid', () => {
    const [session] = groupSessions([lap({ valid: false }), lap({ startMin: 4, valid: false })]);
    expect(session.best).toBeNull();
    expect(session.validCount).toBe(0);
  });

  it('keeps a session’s id when laps are added after it, and measures its span', () => {
    const first = lap({ startMin: 0 });
    const second = lap({ startMin: 4 });
    const before = groupSessions([first, second])[0];
    const after = groupSessions([first, second, lap({ startMin: 8 })])[0];
    expect(after.id).toBe(before.id);
    expect(after.startedAt).toBe(T0);
    expect(after.endedAt).toBe(T0 + 8 * MIN + 210_000);
  });

  it('copes with a lap whose start is not a date', () => {
    const sessions = groupSessions([lap({ startedAt: 'yesterday' }), lap({ startedAt: 'also not a date' })]);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.flatMap((s) => s.laps)).toHaveLength(2);
  });

  it('is empty for no laps', () => {
    expect(groupSessions([])).toEqual([]);
  });
});
