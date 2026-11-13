import { asService, databaseConfigured } from './db';
import { DiskStore } from './files';

export type Part = 'ok' | 'down' | 'off';
export interface DeepHealth { ok: boolean; database: Part; storage: Part }

const TIMEOUT_MS = 3_000;
// An external uptime monitor asks every minute or so; anything else asking more often gets the last answer, so this
// public route cannot be used to make the database and the disk work.
const MAX_AGE_MS = 5_000;
let last: { at: number; value: DeepHealth } | undefined;
/** Tests: forget the last answer. */
export const forgetDeepHealth = () => { last = undefined; };

const within = <T,>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
  work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

/**
 * Asks the database and the file store, for real (the plain /api/health must never fail on a blip, this one is for
 * an uptime monitor and does). Only 'ok' counts as healthy: a missing configuration is as bad as a dead service here.
 */
export async function deepHealth(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<DeepHealth> {
  if (last && now - last.at < MAX_AGE_MS) return last.value;
  const [database, storage] = await Promise.all([
    databaseConfigured(env) ? within(asService((client) => client.query('SELECT 1'))).then((): Part => 'ok', (): Part => 'down') : Promise.resolve<Part>('off'),
    env.STORAGE_DIR ? within(new DiskStore(env.STORAGE_DIR).probe()).then((fine): Part => (fine ? 'ok' : 'down'), (): Part => 'down') : Promise.resolve<Part>('off'),
  ]);
  const value = { ok: database === 'ok' && storage === 'ok', database, storage };
  last = { at: Date.now(), value };
  return value;
}
