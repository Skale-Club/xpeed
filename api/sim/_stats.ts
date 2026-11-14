// GET /api/sim/v1/stats?range=7d|30d|90d|1y|all : what the Overview dashboard shows, for the signed-in person (docs/platform/API-V1.md).
// The numbers come from one database function (sim_v1_stats) that runs as the person, so row level security keeps everyone to their own
// laps; no lap file is read. This file checks the range, turns it into UTC day windows and shapes the answer; v1.ts routes to it.
import type { SupabaseClient } from '@supabase/supabase-js';
import { cachedStats, rememberStats } from './_v1cache';
import { call, Invalid } from './_v1util';

export const RANGES = ['7d', '30d', '90d', '1y', 'all'] as const;
export type StatsRange = (typeof RANGES)[number];
export const DEFAULT_RANGE: StatsRange = '30d';

/** How many days each range spans (`all` has no fixed length: it starts at the person's first lap). */
const DAYS: Record<Exclude<StatsRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
/** The calendar heatmap goes back this many days (12 months) when the range is 90 days or more. */
export const HEATMAP_DAYS = 365;

const DAY_MS = 86_400_000;

/** `30d` when absent or empty; any other value that is not one of the five ranges is a 400 `invalid_range`. */
export function rangeParam(params: URLSearchParams): StatsRange {
  const value = params.get('range');
  if (value === null || value === '') return DEFAULT_RANGE;
  if ((RANGES as readonly string[]).includes(value)) return value as StatsRange;
  throw new Invalid('invalid_range');
}

export interface StatsWindows { from: string | null; to: string; prevFrom: string | null; heatFrom: string | null }

/**
 * The windows of a range, as ISO instants at UTC midnight. A range is whole UTC days ending today (today included), `to` is the start of
 * tomorrow, `prevFrom` starts the period of the same length before it, `heatFrom` starts the 12-month heatmap (only from 90 days up).
 * `all` has no start (the database uses the first lap) and no previous period.
 */
export function windowsFor(range: StatsRange, now: Date = new Date()): StatsWindows {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const to = today + DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  const heatFrom = range === '7d' || range === '30d' ? null : iso(to - HEATMAP_DAYS * DAY_MS);
  if (range === 'all') return { from: null, to: iso(to), prevFrom: null, heatFrom };
  const length = DAYS[range] * DAY_MS;
  return { from: iso(to - length), to: iso(to), prevFrom: iso(to - 2 * length), heatFrom };
}

/** The answer of `GET /stats`: cached for a few seconds per person and range, dropped by an upload or a deletion (see _v1cache.ts). */
export async function statsFor(db: SupabaseClient, userId: string, params: URLSearchParams, now: Date = new Date()): Promise<Record<string, unknown>> {
  const range = rangeParam(params);
  const hit = cachedStats(userId, range, now.getTime());
  if (hit !== undefined) return hit as Record<string, unknown>;
  const windows = windowsFor(range, now);
  const answer = await call<Record<string, unknown> | null>(db, 'sim_v1_stats', {
    p_from: windows.from, p_to: windows.to, p_prev_from: windows.prevFrom, p_heat_from: windows.heatFrom,
  });
  if (!answer) throw new Error('sim_v1_stats returned nothing');
  const body: Record<string, unknown> = { ...answer, range: { key: range, ...(answer.range as Record<string, unknown>) } };
  rememberStats(userId, range, body, now.getTime());
  return body;
}
