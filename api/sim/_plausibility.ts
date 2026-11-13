// Is this lap believable? Checked on the file when it arrives (inside the ingest, stored beside the lap) so that a lap that
// cannot be real never reaches a leaderboard. A lap that fails is still kept and still the driver's own: it just does not rank.
// The result is small: which checks failed and the numbers that failed them, for the moderators (GET /v1/admin/laps/<id>).
import { gunzipLap, LAP_LIMITS, type LapFile } from '../../src/lib/sim/lap-file';
import type { Backend } from '../_backend';
import { failed } from './_v1util';

/** The thresholds, in one place (docs/platform/API-V1.md lists them). */
export const PLAUSIBILITY = {
  /** The sector times add up to the lap time within this many milliseconds. */
  sectorSumToleranceMs: 50,
  /** The elapsed time of the `t` channel matches the lap time within this fraction of it. */
  elapsedTolerance: 0.005,
  /** The distance covered matches the track length within this fraction of it (only when the header gives the length). */
  distanceTolerance: 0.03,
  /** No sample above this speed (m/s, 540 km/h) and none below zero. */
  maxSpeedMs: 150,
  /** No gap larger than this between two samples of the `t` channel, seconds. */
  maxGapS: 2,
  /** The sample count is within this fraction of what the sample rate and the lap time give (but never less than `sampleCountSlack` samples). */
  sampleCountTolerance: 0.15,
  sampleCountSlack: 3,
} as const;

export const CHECKS = ['sector_sum', 'elapsed_time', 'distance', 'speed_range', 'sample_count', 'time_gap'] as const;
export type CheckName = (typeof CHECKS)[number] | 'file_unreadable';

export interface PlausibilityFailure { check: CheckName; detail: Record<string, number | string> }
export interface PlausibilityResult { plausible: boolean; failed: PlausibilityFailure[] }

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** First and last finite value of a channel; null when there is none. */
function span(column: Float32Array | undefined): { first: number; last: number } | null {
  if (!column) return null;
  let first: number | null = null, last: number | null = null;
  for (const value of column) if (Number.isFinite(value)) { if (first === null) first = value; last = value; }
  return first === null || last === null ? null : { first, last };
}

export function checkPlausibility(lap: LapFile): PlausibilityResult {
  const { header, data } = lap;
  const timeMs = header.lap.timeMs;
  const out: PlausibilityFailure[] = [];

  // 1. The sectors add up to the lap.
  const sectors = header.lap.sectorsMs;
  if (sectors && sectors.length > 0) {
    const sum = sectors.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - timeMs) > PLAUSIBILITY.sectorSumToleranceMs) out.push({ check: 'sector_sum', detail: { sectorsSumMs: sum, lapMs: timeMs, toleranceMs: PLAUSIBILITY.sectorSumToleranceMs } });
  }

  // 2. The clock of the file ran as long as the lap.
  const t = span(data.t);
  if (t) {
    const elapsedMs = (t.last - t.first) * 1000;
    const allowed = timeMs * PLAUSIBILITY.elapsedTolerance;
    if (!(Math.abs(elapsedMs - timeMs) <= allowed)) out.push({ check: 'elapsed_time', detail: { elapsedMs: round(elapsedMs, 1), lapMs: timeMs, allowedMs: round(allowed, 1) } });
  }

  // 3. The car covered about one lap of the track.
  const length = header.track.lengthM;
  const dist = span(data.dist);
  if (length && length > 0 && dist) {
    const covered = dist.last - dist.first;
    const allowed = length * PLAUSIBILITY.distanceTolerance;
    if (!(Math.abs(covered - length) <= allowed)) out.push({ check: 'distance', detail: { coveredM: round(covered, 1), trackLengthM: length, allowedM: round(allowed, 1) } });
  }

  // 4. No speed a car cannot have.
  if (data.speed) {
    let max = -Infinity, min = Infinity, bad = 0;
    for (const value of data.speed) {
      if (!Number.isFinite(value)) continue;
      if (value > max) max = value;
      if (value < min) min = value;
      if (value > PLAUSIBILITY.maxSpeedMs || value < 0) bad++;
    }
    if (bad > 0) out.push({ check: 'speed_range', detail: { samples: bad, maxMs: round(max, 1), minMs: round(min, 1), limitMs: PLAUSIBILITY.maxSpeedMs } });
  }

  // 5. The sample rate and the lap time give about the number of samples there are.
  const expected = header.sampleRateHz * (timeMs / 1000);
  const allowedCount = Math.max(PLAUSIBILITY.sampleCountSlack, expected * PLAUSIBILITY.sampleCountTolerance);
  if (!(Math.abs(header.sampleCount - expected) <= allowedCount)) {
    out.push({ check: 'sample_count', detail: { sampleCount: header.sampleCount, expected: round(expected, 1), sampleRateHz: header.sampleRateHz, lapMs: timeMs } });
  }

  // 6. The clock never stops for long, and never runs backwards.
  if (data.t) {
    let previous: number | null = null, largest = 0, at = -1, backwards = 0;
    for (let i = 0; i < data.t.length; i++) {
      const value = data.t[i];
      if (!Number.isFinite(value)) continue;
      if (previous !== null) {
        const step = value - previous;
        if (step < 0) backwards++;
        else if (step > largest) { largest = step; at = i; }
      }
      previous = value;
    }
    if (largest > PLAUSIBILITY.maxGapS || backwards > 0) {
      out.push({ check: 'time_gap', detail: { largestGapS: round(largest, 3), atSample: at, backwardsSteps: backwards, limitS: PLAUSIBILITY.maxGapS } });
    }
  }

  return { plausible: out.length === 0, failed: out };
}

/** The shape stored in `sim_laps.plausibility`. */
export const plausibilityJson = (result: PlausibilityResult) => ({ v: 1, failed: result.failed });

export interface RecheckResult { checked: number; plausible: number; implausible: number; remaining: number }

/**
 * Laps that arrived before the check existed have no answer (`plausible` is null, so they are on no leaderboard). This reads their
 * files and fills it in, a few at a time; a file that cannot be read is marked implausible (check `file_unreadable`) so it is not tried
 * again forever. Callable on its own: the admin endpoint POST /v1/admin/recheck runs it.
 */
export async function recheckLaps(backend: Backend, limit: number): Promise<RecheckResult> {
  const batch = await backend.service.rpc('sim_unchecked_laps', { p_limit: limit });
  if (batch.error) throw batch.error;
  const { rows, remaining } = batch.data as { rows: { id: string; storage_path: string }[]; remaining: number };
  const result: RecheckResult = { checked: 0, plausible: 0, implausible: 0, remaining: Number(remaining) };
  for (const row of rows) {
    let verdict: PlausibilityResult;
    try {
      const file = await backend.service.storage.from('sim-laps').download(row.storage_path);
      if (file.error || !file.data) throw file.error ?? new Error('no file');
      verdict = checkPlausibility(await gunzipLap(new Uint8Array(await file.data.arrayBuffer()), { maxBytes: LAP_LIMITS.unpackedBytes }));
    } catch (error) {
      failed('sim_recheck_unreadable', error);
      verdict = { plausible: false, failed: [{ check: 'file_unreadable', detail: {} }] };
    }
    const saved = await backend.service.rpc('sim_set_plausibility', { p_id: row.id, p_plausible: verdict.plausible, p_plausibility: plausibilityJson(verdict) });
    if (saved.error) throw saved.error;
    result.checked++;
    if (verdict.plausible) result.plausible++; else result.implausible++;
    result.remaining--;
  }
  return result;
}
