// Retention: laps older than 90 days that are not a personal best and not marked are reduced to 10 Hz.
// The summary columns of the row (sample_count, time, sectors...) keep the full-detail numbers; only the file shrinks
// and the row says so (`reduced = true`, the new `size_bytes`).
//
// A lap is never lost. For each lap, in this order:
//   1. read the file and open it with the strict reader (a file that does not open is left alone);
//   2. decimate, write it with the strict writer, read the result back and compare it with the original (same header
//      but the sample count and rate, same lap time, same first and last samples, same channels);
//   3. write the reduced bytes under a temporary key and read them back;
//   4. replace the real key with them (an atomic write on both drivers) and read that back;
//   5. update the row, only if it is still not reduced;
//   6. remove the temporary key.
// If 4 or 5 goes wrong the original bytes (still in memory) are put back, so the row and the file never disagree: either
// both say "full detail" or both say "reduced".
import { gunzipLap, gzipLap, type LapFile } from '../src/lib/sim/lap-file';
import type { FileStore } from './files';

export const SIM_LAPS_BUCKET = 'sim-laps';

/** The one thing retention needs from a database: pg's Pool and PGlite both have it. */
export interface RetentionDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface LapCandidate { id: string; userId: string; storagePath: string; sizeBytes: number }

// ---------------------------------------------------------------- which laps

/**
 * The columns it relies on: sim_laps.reduced and sim_laps.marked (a lap the person asked to keep in full detail),
 * sim_personal_bests.lap_id, and sim_laps.id, user_id, storage_path, size_bytes, started_at.
 * "Older than N days" is measured on started_at (when the lap was driven), not created_at.
 */
export const CANDIDATES_SQL = `
  SELECT l.id, l.user_id, l.storage_path, l.size_bytes, l.started_at, l.reduced, l.marked,
         EXISTS (SELECT 1 FROM public.sim_personal_bests pb WHERE pb.lap_id = l.id) AS is_personal_best
    FROM public.sim_laps l
   WHERE l.started_at < $1
     AND l.reduced = false
     AND l.marked = false
     AND NOT EXISTS (SELECT 1 FROM public.sim_personal_bests pb WHERE pb.lap_id = l.id)
     AND l.id <> ALL($3::uuid[])
   ORDER BY l.started_at ASC
   LIMIT $2`;

/** `reduced = false` in the WHERE makes a second instance running at the same time harmless. */
export const MARK_REDUCED_SQL = 'UPDATE public.sim_laps SET reduced = true, size_bytes = $2 WHERE id = $1 AND reduced = false RETURNING id';

const truthy = (value: unknown) => value === true || value === 't' || value === 'true' || value === 1;

/**
 * The laps that may be reduced: older than the cutoff, not already reduced, not marked, not a personal best.
 * The query already filters; the rows it returns are checked again here from their own flags, so a query that is
 * wrong or too loose after a schema change cannot send a personal best or a marked lap to the reducer.
 */
export async function candidatesForReduction(
  db: RetentionDb,
  { cutoff, limit = 25, excludeIds = [] }: { cutoff: Date; limit?: number; excludeIds?: string[] },
): Promise<LapCandidate[]> {
  const { rows } = await db.query(CANDIDATES_SQL, [cutoff.toISOString(), limit, excludeIds]);
  const result: LapCandidate[] = [];
  for (const row of rows) {
    const startedAt = new Date(row.started_at as string | number | Date).getTime();
    if (truthy(row.reduced) || truthy(row.marked) || truthy(row.is_personal_best)) continue;
    if (!(startedAt < cutoff.getTime())) continue;
    if (excludeIds.includes(String(row.id))) continue;
    if (typeof row.storage_path !== 'string' || !row.storage_path) continue;
    result.push({ id: String(row.id), userId: String(row.user_id), storagePath: row.storage_path, sizeBytes: Number(row.size_bytes) });
  }
  return result.slice(0, limit);
}

// ---------------------------------------------------------------- the reduction itself

/**
 * Keeps about `hz` samples per second, chosen from the real clock (`t`): the first and the last sample always stay,
 * every channel is cut at the same positions. Returns null when there is nothing to remove.
 */
export function decimateLap(lap: LapFile, hz: number): LapFile | null {
  const count = lap.header.sampleCount;
  const t = lap.data.t;
  if (count < 3 || !(hz > 0)) return null;
  const interval = 1 / hz;
  const keep: number[] = [0];
  let lastKept = 0;
  for (let i = 1; i < count - 1; i++) {
    const gap = t[i] - t[lastKept];
    // `t` is the truth; a sample without a clock value falls back to the nominal rate.
    const due = Number.isFinite(gap) ? gap >= interval * 0.999 : (i - lastKept) / lap.header.sampleRateHz >= interval * 0.999;
    if (due) { keep.push(i); lastKept = i; }
  }
  // The last sample closes the lap. If it landed on top of the previous kept one, that one makes way (never the first).
  const lastGap = t[count - 1] - t[lastKept];
  if (keep.length > 1 && Number.isFinite(lastGap) && lastGap < interval * 0.5) keep.pop();
  keep.push(count - 1);
  if (keep.length >= count) return null;

  const data: Record<string, Float32Array> = {};
  for (const { id } of lap.header.channels) {
    const column = lap.data[id];
    const reduced = new Float32Array(keep.length);
    for (let k = 0; k < keep.length; k++) reduced[k] = column[keep[k]];
    data[id] = reduced;
  }
  return { header: { ...lap.header, sampleCount: keep.length, sampleRateHz: Math.min(lap.header.sampleRateHz, hz) }, data };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
const sameColumn = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]) || (Number.isNaN(value) && Number.isNaN(b[i])));

/** Why a reduced file is not an acceptable replacement, or null when it is. */
export function problemWithReduction(original: LapFile, reduced: LapFile, expected: LapFile): string | null {
  // Everything in the header except the sample count and rate must be exactly what it was: the lap time first.
  const { sampleCount: _a, sampleRateHz: _b, ...before } = original.header;
  const { sampleCount: _c, sampleRateHz: _d, ...after } = reduced.header;
  if (reduced.header.lap.timeMs !== original.header.lap.timeMs) return 'lap time changed';
  if (JSON.stringify(before) !== JSON.stringify(after)) return 'header changed';
  if (reduced.header.sampleCount !== expected.header.sampleCount || reduced.header.sampleCount >= original.header.sampleCount) return 'sample count wrong';
  for (const { id } of original.header.channels) {
    const column = reduced.data[id];
    if (!column || !sameColumn(column, expected.data[id])) return `channel ${id} differs`;
    const full = original.data[id];
    if (!Object.is(column[0], full[0]) && !(Number.isNaN(column[0]) && Number.isNaN(full[0]))) return `first sample of ${id} differs`;
    const last = full.length - 1;
    if (!Object.is(column[column.length - 1], full[last]) && !(Number.isNaN(full[last]) && Number.isNaN(column[column.length - 1]))) return `last sample of ${id} differs`;
  }
  return null;
}

export type ReduceOutcome = 'reduced' | 'already_low' | 'unreadable' | 'missing_file' | 'row_gone' | 'failed';

export interface ReduceOneContext { db: RetentionDb; store: FileStore; bucket: string; hz: number }

/** Reduces one lap. Never throws: the outcome says what happened, and on 'failed' the file and the row are as they were. */
export async function reduceLap(candidate: LapCandidate, { db, store, bucket, hz }: ReduceOneContext): Promise<{ outcome: ReduceOutcome; savedBytes: number; reason?: string }> {
  const path = candidate.storagePath;
  const slash = path.lastIndexOf('/');
  const tempPath = `${path.slice(0, slash + 1)}.reducing-${path.slice(slash + 1)}`;
  let original: Uint8Array | null;
  try {
    original = await store.get(bucket, path);
    if (!original) return { outcome: 'missing_file', savedBytes: 0 };
  } catch (error) { return { outcome: 'failed', savedBytes: 0, reason: `read: ${errorText(error)}` }; }

  let lap: LapFile;
  try { lap = await gunzipLap(original); } catch (error) { return { outcome: 'unreadable', savedBytes: 0, reason: errorText(error) }; }

  let reducedLap: LapFile | null;
  let packed: Uint8Array;
  try {
    reducedLap = decimateLap(lap, hz);
    if (!reducedLap) {
      await db.query(MARK_REDUCED_SQL, [candidate.id, original.length]);
      return { outcome: 'already_low', savedBytes: 0 };
    }
    packed = await gzipLap(reducedLap);
    const problem = problemWithReduction(lap, await gunzipLap(packed), reducedLap);
    if (problem) return { outcome: 'failed', savedBytes: 0, reason: `verify: ${problem}` };
  } catch (error) { return { outcome: 'failed', savedBytes: 0, reason: `reduce: ${errorText(error)}` }; }
  // Gzip of fewer samples is smaller in practice; if it somehow is not, the lap is left as it is and the row says nothing.
  if (packed.length >= original.length) return { outcome: 'failed', savedBytes: 0, reason: 'not smaller' };

  try {
    await store.remove(bucket, [tempPath]); // a leftover of an interrupted run
    await store.put(bucket, tempPath, packed, { upsert: true });
    const staged = await store.get(bucket, tempPath);
    if (!staged || !sameBytes(staged, packed)) throw new Error('temporary copy does not match');
  } catch (error) {
    await store.remove(bucket, [tempPath]).catch(() => undefined);
    return { outcome: 'failed', savedBytes: 0, reason: `stage: ${errorText(error)}` };
  }

  // Past this point the real key changes. Whatever fails, put the original back.
  const restore = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await store.put(bucket, path, original, { upsert: true }); return; } catch (error) {
        console.error(JSON.stringify({ event: 'retention_restore_failed', attempt, message: errorText(error) }));
        await new Promise((done) => setTimeout(done, 200 * attempt));
      }
    }
  };
  let result: { outcome: ReduceOutcome; savedBytes: number; reason?: string };
  try {
    try {
      await store.put(bucket, path, packed, { upsert: true });
    } catch (error) {
      // The write may or may not have landed: look. The reduced bytes in place are fine, anything else is put right.
      const now = await store.get(bucket, path).catch(() => null);
      if (!now || !sameBytes(now, packed)) { await restore(); throw error; }
    }
    const written = await store.get(bucket, path);
    if (!written || !sameBytes(written, packed)) throw new Error('replaced file does not match');
    const updated = await db.query(MARK_REDUCED_SQL, [candidate.id, packed.length]);
    if (updated.rows.length > 0) {
      result = { outcome: 'reduced', savedBytes: original.length - packed.length };
    } else {
      // The update only matches rows that are not reduced yet. Deleted meanwhile, or reduced by another run: nothing
      // to keep in sync, leave what is there. Still a full-detail row: the update failed, so the file goes back.
      const stillThere = await db.query('SELECT reduced FROM public.sim_laps WHERE id = $1', [candidate.id]);
      if (stillThere.rows.length === 0) result = { outcome: 'row_gone', savedBytes: 0 };
      else if (truthy(stillThere.rows[0].reduced)) result = { outcome: 'reduced', savedBytes: 0 };
      else throw new Error('row not updated');
    }
  } catch (error) {
    // The row says "full detail", so the file must too.
    const current = await store.get(bucket, path).catch(() => null);
    if (!current || !sameBytes(current, original)) await restore();
    result = { outcome: 'failed', savedBytes: 0, reason: `replace: ${errorText(error)}` };
  }
  await store.remove(bucket, [tempPath]).catch(() => undefined);
  return result;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'unknown').slice(0, 160);

// ---------------------------------------------------------------- a run

export interface ReduceOptions {
  db: RetentionDb;
  store: FileStore;
  olderThanDays?: number;
  hz?: number;
  bucket?: string;
  /** Candidates fetched per query. */
  batchSize?: number;
  /** Stop starting new laps after this many milliseconds (a lap in progress is finished). */
  budgetMs?: number;
  /** Stop after this many laps whatever the time. */
  maxLaps?: number;
  /** Clock for the time budget only (tests); the age cutoff always uses the real date. */
  now?: () => number;
}

export interface ReduceSummary {
  considered: number; reduced: number; alreadyLow: number; unreadable: number; missingFile: number; failed: number;
  savedBytes: number; ms: number; budgetReached: boolean;
}

/** Reduces old laps in small batches inside a time budget. Safe to run twice at once and to interrupt at any point. */
export async function reduceOldLaps(options: ReduceOptions): Promise<ReduceSummary> {
  const { db, store } = options;
  const olderThanDays = options.olderThanDays ?? 90, hz = options.hz ?? 10, bucket = options.bucket ?? SIM_LAPS_BUCKET;
  const batchSize = options.batchSize ?? 25, budgetMs = options.budgetMs ?? 5 * 60_000, maxLaps = options.maxLaps ?? 500;
  const clock = options.now ?? Date.now;
  const started = clock();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
  const summary: ReduceSummary = { considered: 0, reduced: 0, alreadyLow: 0, unreadable: 0, missingFile: 0, failed: 0, savedBytes: 0, ms: 0, budgetReached: false };
  // A lap that failed or could not be read stays a candidate in the database; it is only tried once per run.
  const seen: string[] = [];

  outer: for (;;) {
    if (summary.considered >= maxLaps) { summary.budgetReached = true; break; }
    const batch = await candidatesForReduction(db, { cutoff, limit: Math.min(batchSize, maxLaps - summary.considered), excludeIds: seen });
    if (batch.length === 0) break;
    for (const candidate of batch) {
      if (clock() - started >= budgetMs) { summary.budgetReached = true; break outer; }
      seen.push(candidate.id);
      summary.considered++;
      const result = await reduceLap(candidate, { db, store, bucket, hz });
      summary.savedBytes += result.savedBytes;
      switch (result.outcome) {
        case 'reduced': summary.reduced++; break;
        case 'already_low': summary.alreadyLow++; break;
        case 'unreadable': summary.unreadable++; break;
        case 'missing_file': summary.missingFile++; break;
        case 'row_gone': break;
        default: summary.failed++;
      }
    }
  }
  summary.ms = clock() - started;
  return summary;
}
