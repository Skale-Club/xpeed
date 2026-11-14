// The arithmetic behind the leaderboard screen: the podium, where the person stands, the bars that show the gaps and the spread of the field.
// Pure functions of the answers of GET /leaderboard and GET /leaderboard/me (docs/platform/API-V1.md); nothing here reads or draws anything.
import { formatLapTime } from '@/lib/sim/analysis';
import type { LeaderboardEntry } from '@/lib/sim/social-client';

/** The first three rows of the board, in rank order. With ties (1, 2, 2, 4) these are the first three rows, so two drivers can share a step. */
export function podiumOf(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  return entries.slice(0, 3).filter((entry) => entry.rank <= 3);
}

/** The podium as it stands on the stage: second, first, third (the winner in the middle). Fewer than three drivers keep their rank order. */
export function podiumStage(podium: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  if (podium.length < 3) return [...podium];
  return [podium[1], podium[0], podium[2]];
}

export type StandingKind = 'leader' | 'podium' | 'field';
export interface Standing {
  kind: StandingKind;
  rank: number;
  total: number;
  /** How far behind the fastest time, in ms (0 for the leader). */
  gapToLeaderMs: number;
  /** How far from the time of third place, in ms; null when already on the podium or when third place is not known. */
  gapToPodiumMs: number | null;
  /** How far ahead of the next driver, in ms; only for the leader and only when the next driver is slower. */
  leadOverNextMs: number | null;
}

/**
 * Where a person stands, in numbers. `podium` is the board's first three rows (their times give the podium line); `me` is the person's row.
 * The total can be larger than what is loaded: only the ranks and times matter here.
 */
export function standingOf(me: Pick<LeaderboardEntry, 'rank' | 'timeMs' | 'gapMs'>, total: number, entries: readonly Pick<LeaderboardEntry, 'rank' | 'timeMs'>[]): Standing {
  const third = entries[2];
  const kind: StandingKind = me.rank <= 1 ? 'leader' : me.rank <= 3 ? 'podium' : 'field';
  const next = entries.find((entry) => entry.timeMs > me.timeMs);
  return {
    kind,
    rank: me.rank,
    total,
    gapToLeaderMs: Math.max(0, me.gapMs),
    gapToPodiumMs: kind === 'field' && third ? Math.max(0, me.timeMs - third.timeMs) : null,
    leadOverNextMs: kind === 'leader' && next ? next.timeMs - me.timeMs : null,
  };
}

/** A gap for a sentence: 0.412 under a second, 1.90 up to a minute, 1:05.2 beyond; the decimal mark follows the language. */
export function formatSeconds(ms: number, locale: string): string {
  const seconds = Math.max(0, ms) / 1000;
  const digits = seconds < 1 ? 3 : 2;
  try {
    if (seconds >= 60) {
      const minutes = Math.floor(seconds / 60);
      const rest = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, minimumIntegerDigits: 2 }).format(seconds - minutes * 60);
      return `${minutes}:${rest}`;
    }
    return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(seconds);
  } catch {
    return seconds.toFixed(digits);
  }
}

/** The share (0 to 1) of the widest gap that a driver's gap takes: the length of the bar in the table. Nothing to scale against is an empty bar. */
export function gapShare(gapMs: number, maxGapMs: number): number {
  if (!Number.isFinite(gapMs) || !Number.isFinite(maxGapMs) || maxGapMs <= 0 || gapMs <= 0) return 0;
  return Math.min(1, gapMs / maxGapMs);
}

export interface SpreadDot { lapId: string; rank: number; /** 0 (the leader's time) to 1 (the slowest time shown). */ at: number; isMe: boolean }
export interface Spread {
  fastestMs: number;
  slowestMs: number;
  dots: SpreadDot[];
  /** Where third place ends on the bar (0 to 1); null when there is no podium to mark. */
  podiumAt: number | null;
}

/**
 * The field on one line: every known time as a dot between the fastest and the slowest, the person's in front, and the end of the podium.
 * The rows are the ones loaded plus the person's own row and the neighbours the server named (the person may be far below the loaded page).
 * Null when fewer than two times are known: one dot says nothing about a spread.
 */
export function spreadOf(entries: readonly LeaderboardEntry[], extra: readonly LeaderboardEntry[] = []): Spread | null {
  const byLap = new Map<string, LeaderboardEntry>();
  for (const entry of [...entries, ...extra]) byLap.set(entry.lapId, entry);
  const all = [...byLap.values()].sort((p, q) => p.timeMs - q.timeMs || p.rank - q.rank);
  if (all.length < 2) return null;
  const fastestMs = all[0].timeMs;
  const slowestMs = all[all.length - 1].timeMs;
  const width = slowestMs - fastestMs;
  const at = (timeMs: number) => (width > 0 ? (timeMs - fastestMs) / width : 0);
  const third = all.find((entry) => entry.rank === 3) ?? (entries[2] ? entries[2] : null);
  return {
    fastestMs,
    slowestMs,
    dots: all.map((entry) => ({ lapId: entry.lapId, rank: entry.rank, at: at(entry.timeMs), isMe: entry.isMe })),
    podiumAt: third && all.length > 3 ? at(third.timeMs) : null,
  };
}

/** What a screen reader gets for the spread bar. */
export const spreadLabelValues = (spread: Spread, meMs: number | null) => ({
  fastest: formatLapTime(spread.fastestMs),
  slowest: formatLapTime(spread.slowestMs),
  you: meMs === null ? '' : formatLapTime(meMs),
});
