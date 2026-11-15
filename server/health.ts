import { statfs } from 'node:fs/promises';
import { asService, databaseConfigured } from './db';
import { createStore, DEFAULT_STORAGE_DIR, storageConfigured, storageDriver } from './storage-driver';

export type Part = 'ok' | 'down' | 'off';
export interface DeepHealth { ok: boolean; database: Part; storage: Part }

/** How full the volume that holds the uploaded files is: a percentage, never a path or a size. */
export interface DiskUsage { usedPercent: number; freePercent: number }
/** A disk this full is the alarm: .github/workflows/uptime.yml fails above it (docs/operations/alerts.md). */
export const DISK_ALARM_PERCENT = 85;

/**
 * Disk use of the files volume (STORAGE_DIR, `/data/files` by default), like `df`: used / (used + available) for the volume that
 * holds the folder. null when the files are not on a disk of this server (the s3 driver), or the volume cannot be read.
 * Percentages only: no path, no byte count, nothing about the server leaves in the answer.
 */
export async function diskUsage(env: NodeJS.ProcessEnv = process.env, read: typeof statfs = statfs): Promise<DiskUsage | null> {
  try {
    if (storageDriver(env) !== 'disk') return null;
    const info = await read(env.STORAGE_DIR || DEFAULT_STORAGE_DIR);
    const total = Number(info.blocks), available = Number(info.bavail);
    if (!(total > 0) || !(available >= 0)) return null;
    const used = Math.min(100, Math.max(0, ((total - available) / total) * 100));
    return { usedPercent: Math.round(used * 10) / 10, freePercent: Math.round((100 - used) * 10) / 10 };
  } catch {
    return null;
  }
}

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
    storageConfigured(env) ? within(createStore(env).probe()).then((fine): Part => (fine ? 'ok' : 'down'), (): Part => 'down') : Promise.resolve<Part>('off'),
  ]);
  const value = { ok: database === 'ok' && storage === 'ok', database, storage };
  last = { at: Date.now(), value };
  return value;
}
