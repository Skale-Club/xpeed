// Which FileStore the server uses, decided by the environment:
//
//   STORAGE_DRIVER=disk (default)   STORAGE_DIR (default /data/files)
//   STORAGE_DRIVER=s3               S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (required),
//                                   S3_REGION (default "auto", what R2 wants), S3_FORCE_PATH_STYLE (default true)
//
// Cloudflare R2, Backblaze B2 and Hetzner Object Storage all work with the s3 driver. See docs/platform/STORAGE.md.
import { DiskStore, type FileStore } from './files';
import { S3Store, type S3Config } from './s3';

export type StorageDriver = 'disk' | 's3';
type Env = Record<string, string | undefined>;

export const DEFAULT_STORAGE_DIR = '/data/files';

/** 'disk' unless STORAGE_DRIVER says 's3'. Anything else is a mistake in the configuration and throws, so a typo cannot silently fall back to the disk. */
export function storageDriver(env: Env = process.env): StorageDriver {
  const raw = (env.STORAGE_DRIVER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'disk') return 'disk';
  if (raw === 's3') return 's3';
  throw new Error(`STORAGE_DRIVER must be "disk" or "s3", not "${raw}"`);
}

const truthy = (value: string | undefined, fallback: boolean) => {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  throw new Error(`S3_FORCE_PATH_STYLE must be true or false, not "${text}"`);
};

const S3_REQUIRED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

/** The S3 settings from the environment; throws naming the missing variables (never their values). */
export function s3ConfigFromEnv(env: Env = process.env): S3Config {
  const missing = S3_REQUIRED.filter((name) => !(env[name] ?? '').trim());
  if (missing.length) throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(', ')}`);
  const endpoint = env.S3_ENDPOINT!.trim();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('S3_ENDPOINT must be a URL such as https://<account>.r2.cloudflarestorage.com'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('S3_ENDPOINT must start with https://');
  return {
    endpoint: `${url.protocol}//${url.host}`,
    region: (env.S3_REGION ?? '').trim() || 'auto',
    bucket: env.S3_BUCKET!.trim(),
    accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
    forcePathStyle: truthy(env.S3_FORCE_PATH_STYLE, true),
  };
}

/** Throws at start-up when the chosen driver is not fully configured, so a bad deploy fails at once and not on the first upload. */
export function assertStorageEnv(env: Env = process.env): void {
  if (storageDriver(env) === 's3') s3ConfigFromEnv(env);
}

/** Whether the chosen storage has what it needs (what `/api/health` reports as 'off' when not). Never throws. */
export function storageConfigured(env: Env = process.env): boolean {
  try {
    if (storageDriver(env) === 's3') { s3ConfigFromEnv(env); return true; }
    return Boolean(env.STORAGE_DIR);
  } catch { return false; }
}

/** The store the environment asks for. */
export function createStore(env: Env = process.env): FileStore {
  return storageDriver(env) === 's3' ? new S3Store(s3ConfigFromEnv(env)) : new DiskStore(env.STORAGE_DIR || DEFAULT_STORAGE_DIR);
}
