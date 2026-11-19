// Fills in the tyre compound of laps that arrived before the server stored it (supabase/migrations/20261119120000_sim_lap_tyres.sql).
// Like the plausibility recheck (_plausibility.ts) it is bounded and can be stopped at any time: it works on the laps not read yet, oldest
// first, a few at a time, and a lap is marked read as soon as its header was looked at, so the next run carries on where this one stopped.
// It reads headers only (gunzipLapHeader): the samples of a lap are never unpacked.
import { gunzipLapHeader } from '../../src/lib/sim/lap-file';
import type { Backend } from '../_backend';
import { failed } from './_v1util';

export interface TyreBackfillResult { read: number; withTyre: number; remaining: number }

/**
 * Reads the header of up to `limit` laps whose tyre has not been looked at and stores the compound. A lap of file version 1 has no
 * compound field and its file is not opened. A file that cannot be read is marked read with no compound (so it is not tried forever);
 * the lap itself is untouched otherwise. Callable on its own.
 */
export async function backfillTyres(backend: Backend, limit: number): Promise<TyreBackfillResult> {
  const queue = await backend.service.rpc('sim_tyre_unread_laps', { p_limit: limit });
  if (queue.error) throw queue.error;
  const { rows, remaining } = queue.data as { rows: { id: string; storage_path: string; format_version: number }[]; remaining: number };
  const result: TyreBackfillResult = { read: 0, withTyre: 0, remaining: Number(remaining) };
  for (const row of rows) {
    let tyre: string | null = null;
    if (row.format_version >= 2) {
      try {
        const file = await backend.service.storage.from('sim-laps').download(row.storage_path);
        if (file.error || !file.data) throw file.error ?? new Error('no file');
        tyre = (await gunzipLapHeader(new Uint8Array(await file.data.arrayBuffer()))).tyreCompound ?? null;
      } catch (error) {
        failed('sim_tyre_backfill_unreadable', error);
      }
    }
    const saved = await backend.service.rpc('sim_set_tyre', { p_id: row.id, p_tyre: tyre });
    if (saved.error) throw saved.error;
    result.read++;
    if (tyre) result.withTyre++;
    result.remaining--;
  }
  return result;
}
