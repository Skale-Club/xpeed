import type { V1CarDetail, V1Ref, V1TrackDetail } from '@/lib/sim/v1-client';

/**
 * The progress charts of the track and car pages, as rows: one per day, with the best valid lap of the day (when there was
 * one) and how many laps were driven. Days are UTC dates (`2026-11-10`), oldest first, exactly as the API gives them.
 */

export interface ProgressRow {
  day: string;
  /** Midnight UTC of the day, ms: the x of a time axis. */
  at: number;
  /** The fastest valid lap of the day in seconds; null on a day with no valid lap (for a car: none on the chosen track). */
  bestS: number | null;
  /** The lap's id, to open it. */
  lapId: string | null;
  /** The car that set it (a track page only). */
  car: string | null;
  laps: number;
  validLaps: number;
}

const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/** Every day that has laps or a best lap, oldest first. */
export function trackProgress(progress: V1TrackDetail['progress']): ProgressRow[] {
  const rows = new Map<string, ProgressRow>();
  const row = (day: string): ProgressRow => {
    let found = rows.get(day);
    if (!found) {
      found = { day, at: dayStart(day), bestS: null, lapId: null, car: null, laps: 0, validLaps: 0 };
      rows.set(day, found);
    }
    return found;
  };
  for (const entry of progress.lapsPerDay) Object.assign(row(entry.day), { laps: entry.laps, validLaps: entry.validLaps });
  for (const entry of progress.bestPerDay) Object.assign(row(entry.day), { bestS: entry.bestMs / 1000, lapId: entry.lapId, car: entry.car.name });
  return [...rows.values()].sort((p, q) => p.at - q.at);
}

/**
 * Laps per day for a car and, with a track, the fastest valid lap of each day on that track as the line (laps on different tracks
 * cannot be compared, so a car's line is always about one track). A day with only laps on other tracks has bars and no point.
 */
export function carProgress(progress: V1CarDetail['progress'], trackId: string | null = null): ProgressRow[] {
  const best = new Map((progress.bestPerDay ?? []).filter((entry) => entry.track.id === trackId).map((entry) => [entry.day, entry]));
  return progress.lapsPerDay
    .map((entry) => {
      const fastest = best.get(entry.day);
      return { day: entry.day, at: dayStart(entry.day), bestS: fastest ? fastest.bestMs / 1000 : null, lapId: fastest?.lapId ?? null, car: null, laps: entry.laps, validLaps: entry.validLaps };
    })
    .sort((p, q) => p.at - q.at);
}

/** The tracks a car has a daily best on, the one with the most days first (the one worth drawing), then by name. */
export function carProgressTracks(progress: V1CarDetail['progress']): V1Ref[] {
  const days = new Map<string, { track: V1Ref; days: number }>();
  for (const entry of progress.bestPerDay ?? []) days.set(entry.track.id, { track: entry.track, days: (days.get(entry.track.id)?.days ?? 0) + 1 });
  return [...days.values()].sort((p, q) => q.days - p.days || p.track.name.localeCompare(q.track.name)).map((entry) => entry.track);
}

/** The y range of the best-lap line: a little below the fastest and above the slowest day, so small gains show. */
export function bestRange(rows: readonly ProgressRow[]): { low: number; high: number } | null {
  const times = rows.flatMap((row) => (row.bestS === null ? [] : [row.bestS]));
  if (times.length === 0) return null;
  const fastest = Math.min(...times);
  const slowest = Math.max(...times);
  const pad = Math.max(0.3, (slowest - fastest) * 0.15);
  return { low: Math.floor((fastest - pad) * 10) / 10, high: Math.ceil((slowest + pad) * 10) / 10 };
}

/** Round steps (seconds) a lap-time axis moves in. */
const STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];

/** Ticks for the lap-time axis, on round numbers (`step` is the distance between them in seconds), about `count` of them. */
export function timeTicks(low: number, high: number, count = 4): { ticks: number[]; step: number } {
  const wanted = Math.max(0.01, (high - low) / Math.max(1, count - 1));
  const step = STEPS.find((candidate) => candidate >= wanted) ?? STEPS[STEPS.length - 1];
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + 1e-9; value += step) ticks.push(Math.round(value * 100) / 100);
  return { ticks, step };
}

/** A tick of the lap-time axis: `1:55.8`, or `1:56` when the ticks are whole seconds apart. */
export function formatTick(seconds: number, step: number): string {
  const whole = Math.floor(seconds / 60);
  const rest = seconds - whole * 60;
  return step >= 1 ? `${whole}:${String(Math.round(rest)).padStart(2, '0')}` : `${whole}:${rest.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')}`;
}
