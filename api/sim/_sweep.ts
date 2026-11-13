// Removes stored lap files that no row points at: what is left when a server dies between writing a file and inserting its
// row, or when a cleanup after a failed upload could not run. Callable on its own; something else decides when (a schedule).
//
// A file younger than `olderThanMs` (default 15 minutes) is never touched: an upload in flight has its file in place a moment
// before its row. Staging files (staging-*.xlap.gz) never have a row, so they go the same way once they are old enough.
import { openBackend, type Backend } from '../_backend';

const BUCKET = 'sim-laps';
const PAGE = 1000;
const IN_CHUNK = 100;

export interface SweepResult { scanned: number; removed: string[] }

interface Listed { name: string; id: string | null; updated_at?: string | null; created_at?: string | null }

async function listAll(backend: Backend, prefix: string): Promise<Listed[]> {
  const out: Listed[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await backend.service.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
    if (page.error) throw page.error;
    const rows = (page.data ?? []) as Listed[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function sweepOrphanLaps(options: { backend?: Backend | null; olderThanMs?: number; now?: number } = {}): Promise<SweepResult> {
  const backend = options.backend ?? openBackend();
  if (!backend) throw new Error('storage is not configured');
  const olderThanMs = options.olderThanMs ?? 15 * 60_000;
  const now = options.now ?? Date.now();
  const result: SweepResult = { scanned: 0, removed: [] };

  // The bucket holds one folder per account: <user id>/<hash>.xlap.gz
  for (const folder of (await listAll(backend, '')).filter((entry) => entry.id === null)) {
    const files = (await listAll(backend, folder.name)).filter((entry) => entry.id !== null);
    result.scanned += files.length;
    const old = files
      .filter((entry) => now - Date.parse(entry.updated_at ?? entry.created_at ?? '') >= olderThanMs)
      .map((entry) => `${folder.name}/${entry.name}`);
    const owned = new Set<string>();
    for (let i = 0; i < old.length; i += IN_CHUNK) {
      const rows = await backend.service.from('sim_laps').select('storage_path').in('storage_path', old.slice(i, i + IN_CHUNK));
      if (rows.error) throw rows.error;
      for (const row of rows.data as { storage_path: string }[]) owned.add(row.storage_path);
    }
    const orphans = old.filter((path) => !owned.has(path));
    if (orphans.length === 0) continue;
    const removed = await backend.service.storage.from(BUCKET).remove(orphans);
    if (removed.error) throw removed.error;
    result.removed.push(...orphans);
  }
  return result;
}
