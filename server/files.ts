// File storage for the app (photos, trip CSVs, small JSON records). The rules per bucket are
// the ones the Supabase buckets had; the bytes live behind FileStore so the disk can later be
// swapped for S3/R2 without touching the routes.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Who may use a bucket from a browser. `server` buckets are only reachable by the server itself. */
export type BucketAccess = 'owner' | 'admin-write-public-read' | 'server';
export interface BucketRule { access: BucketAccess; maxBytes: number; mimes: readonly string[] | null }

const IMAGES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MB = 1024 * 1024;

export const BUCKETS: Readonly<Record<string, BucketRule>> = {
  // First path segment is the owner's account id in the three buckets below.
  'session-csv': { access: 'owner', maxBytes: 50 * MB, mimes: ['text/csv', 'application/vnd.ms-excel'] },
  'session-photos': { access: 'owner', maxBytes: 25 * MB, mimes: [...IMAGES, 'image/heic', 'video/mp4', 'video/webm'] },
  'car-photos': { access: 'owner', maxBytes: 5 * MB, mimes: IMAGES },
  'app-icons': { access: 'admin-write-public-read', maxBytes: 2 * MB, mimes: [...IMAGES, 'image/svg+xml'] },
  'brand-assets': { access: 'admin-write-public-read', maxBytes: 2 * MB, mimes: [...IMAGES, 'image/svg+xml'] },
  // Written and read by the server only (api/*), never by the browser.
  'trip-checkpoints': { access: 'server', maxBytes: 256 * 1024, mimes: ['application/json'] },
  'vehicle-fuel-records': { access: 'server', maxBytes: 16 * 1024, mimes: ['application/json'] },
  'shared-trip-media': { access: 'server', maxBytes: 64 * 1024, mimes: ['application/json'] },
};

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  csv: 'text/csv', json: 'application/json', mp4: 'video/mp4', webm: 'video/webm',
};
export const contentTypeOf = (path: string) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
/** Types a browser would run if it were served inline from our origin. */
export const isActiveContent = (type: string) => /html|javascript|xml(?!.*svg)|xhtml/i.test(type);

export class FileError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}

/** A storage path is `a/b/c.ext`: no empty parts, no dots-only parts, no separators or control characters. */
export function checkPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) throw new FileError(400, 'invalid_path');
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || [...part].some((c) => c === '\\' || c.charCodeAt(0) < 32) || part.length > 200) throw new FileError(400, 'invalid_path');
  }
  return parts.join('/');
}
export function checkBucket(bucket: unknown): string {
  if (typeof bucket !== 'string' || !Object.prototype.hasOwnProperty.call(BUCKETS, bucket)) throw new FileError(404, 'bucket_not_found');
  return bucket;
}

export interface ListedFile { name: string; size: number; updatedAt: string; folder: boolean }
export interface FileStore {
  put(bucket: string, path: string, data: Uint8Array, options: { upsert: boolean }): Promise<void>;
  get(bucket: string, path: string): Promise<Uint8Array | null>;
  remove(bucket: string, paths: string[]): Promise<void>;
  /** Direct children of `prefix`, files and folders, like Supabase's list(). */
  list(bucket: string, prefix: string, options?: { limit?: number; offset?: number; search?: string }): Promise<ListedFile[]>;
}

export class DiskStore implements FileStore {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private locate(bucket: string, path: string) {
    const folder = resolve(this.root, checkBucket(bucket));
    const file = resolve(folder, ...checkPath(path).split('/'));
    // Belt and braces: whatever checkPath allowed, the result must stay inside the bucket folder.
    const inside = relative(folder, file);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new FileError(400, 'invalid_path');
    return file;
  }

  async put(bucket: string, path: string, data: Uint8Array, { upsert }: { upsert: boolean }) {
    const file = this.locate(bucket, path);
    await mkdir(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.upload-${randomUUID()}`);
    await writeFile(temp, data, { mode: 0o600 });
    try {
      // link() refuses to replace an existing file, which is exactly "upsert: false", and is atomic.
      if (upsert) await rename(temp, file);
      else await link(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileError(409, 'already_exists', 'The resource already exists');
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }

  async get(bucket: string, path: string) {
    const file = this.locate(bucket, path);
    try {
      const handle = await open(file, constants.O_RDONLY);
      try { return new Uint8Array(await handle.readFile()); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw error;
    }
  }

  /** Writes and deletes a tiny file in the root: proves the volume is mounted and writable by this user. */
  async probe(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      const file = join(this.root, `.probe-${randomUUID()}`);
      await writeFile(file, 'ok', { mode: 0o600 });
      await rm(file, { force: true });
      return true;
    } catch { return false; }
  }

  async remove(bucket: string, paths: string[]) {
    const folder = resolve(this.root, checkBucket(bucket));
    for (const path of paths) {
      const file = this.locate(bucket, path);
      await rm(file, { force: true });
      // Folders only exist while they hold something, as in object storage.
      for (let parent = dirname(file); parent !== folder && parent.startsWith(folder + sep); parent = dirname(parent)) {
        try { await rmdir(parent); } catch { break; }
      }
    }
  }

  async list(bucket: string, prefix: string, { limit = 100, offset = 0, search }: { limit?: number; offset?: number; search?: string } = {}) {
    const directory = prefix ? this.locate(bucket, prefix) : resolve(this.root, checkBucket(bucket));
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const wanted = entries
      .filter((e) => (e.isFile() || e.isDirectory()) && !e.name.startsWith('.') && (!search || e.name.includes(search)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const page = wanted.slice(offset, offset + Math.min(Math.max(limit, 0), 1000));
    return Promise.all(page.map(async (entry) => {
      const info = await stat(join(directory, entry.name));
      return { name: entry.name, size: entry.isFile() ? info.size : 0, updatedAt: info.mtime.toISOString(), folder: entry.isDirectory() };
    }));
  }
}

// ---------------------------------------------------------------- signed links

export interface SignedClaim { bucket: string; path: string; expires: number }
const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** `<payload>.<hmac>`: a link anyone holding it can open until it expires. Needs STORAGE_SECRET. */
export function signLink(secret: string, claim: SignedClaim): string {
  const payload = b64(JSON.stringify(claim));
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function openLink(secret: string, token: string, now = Date.now()): SignedClaim | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SignedClaim;
    return typeof claim.expires === 'number' && claim.expires > now && typeof claim.bucket === 'string' && typeof claim.path === 'string' ? claim : null;
  } catch { return null; }
}
