import type { LibraryLap } from '@/lib/sim/library';

/**
 * A session is a stretch of driving: the same car on the same track, with no long break between laps.
 * Laps are grouped by what they say about themselves (game, track, car, when they started), never by the
 * file they came from, so laps added in any order, from any folder, fall into the right session.
 */

/** A break longer than this between the end of a lap and the start of the next one starts a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface Session<T extends LibraryLap = LibraryLap> {
  /** The first lap's identity, so a session keeps its id as laps are added after it. */
  id: string;
  game: string;
  trackName: string;
  carName: string;
  carClass?: string;
  /** Epoch ms of the start of the first lap, and of the end of the last. */
  startedAt: number;
  endedAt: number;
  /** In the order they were driven. */
  laps: T[];
  validCount: number;
  /** The quickest valid lap, if any. */
  best: T | null;
}

const startOf = (lap: LibraryLap) => {
  const ms = Date.parse(lap.summary.startedAt);
  return Number.isFinite(ms) ? ms : 0;
};
const endOf = (lap: LibraryLap) => startOf(lap) + lap.summary.timeMs;
const sameDriving = (a: LibraryLap, b: LibraryLap) =>
  a.summary.game === b.summary.game && a.summary.trackName === b.summary.trackName && a.summary.carName === b.summary.carName;

export function groupSessions<T extends LibraryLap>(laps: readonly T[]): Session<T>[] {
  const ordered = [...laps].sort((a, b) =>
    a.summary.game.localeCompare(b.summary.game) ||
    a.summary.trackName.localeCompare(b.summary.trackName) ||
    a.summary.carName.localeCompare(b.summary.carName) ||
    startOf(a) - startOf(b) ||
    a.summary.lapNumber - b.summary.lapNumber,
  );

  const groups: T[][] = [];
  for (const lap of ordered) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (current && previous && sameDriving(previous, lap) && startOf(lap) - endOf(previous) <= SESSION_GAP_MS) current.push(lap);
    else groups.push([lap]);
  }

  return groups
    .map((group): Session<T> => {
      const first = group[0];
      const timed = group.filter((lap) => lap.summary.valid && lap.summary.timeMs > 0);
      return {
        id: `${first.summary.game}|${first.summary.trackName}|${first.summary.carName}|${first.summary.startedAt}`,
        game: first.summary.game,
        trackName: first.summary.trackName,
        carName: first.summary.carName,
        ...(first.summary.carClass !== undefined ? { carClass: first.summary.carClass } : {}),
        startedAt: startOf(first),
        endedAt: Math.max(...group.map(endOf)),
        laps: group,
        validCount: timed.length,
        best: timed.reduce<T | null>((best, lap) => (best === null || lap.summary.timeMs < best.summary.timeMs ? lap : best), null),
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}
