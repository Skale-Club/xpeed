import { gunzipLap, type LapFile } from '@/lib/sim/lap-file';
import { bytesOf, readLapFile } from '@/lib/sim/read-lap-file';
import { V1Error, lapFilePath, v1GetBlob } from '@/lib/sim/v1-client';

/**
 * The lap files this browser has downloaded: only a cache. The server is the truth; nothing is ever added by hand, and nothing in
 * here is listed or shown on its own. A lap is fetched by the id the server gave it (`openLap`), parsed with the strict reader and
 * its bytes are kept under that id, so the second open is instant. IndexedDB holds the bytes in one store and a small record per
 * lap (size, last use) in another, so the cache can be trimmed without reading a single lap file.
 *
 * One cache per signed-in account. Past 150 laps or 80 MB the least recently used laps are dropped.
 */

/** A new database: the old one held laps added by hand (their keys are not server ids) and is dropped. */
const DB_NAME = 'xpeed-sim-cache';
const LEGACY_DB_NAME = 'xpeed-sim';
const DB_VERSION = 1;
const LAPS = 'laps';
const META = 'lap-meta';

export const CACHE_LIMITS = { maxLaps: 150, maxBytes: 80 * 1024 * 1024 } as const;

export type LibraryErrorCode = 'unavailable' | 'full' | 'failed';

export class LibraryError extends Error {
  constructor(public readonly code: LibraryErrorCode, message: string) {
    super(message);
    this.name = 'LibraryError';
  }
}

/** The small record kept beside each lap's bytes. */
interface LapMeta {
  userId: string;
  lapId: string;
  /** Bytes of the stored file. */
  size: number;
  /** Ever-increasing: which lap was used last. */
  lastUsed: number;
  /** The server's session of the lap, when the screen that opened it knew it (see `reconcileSession`). */
  sessionId: string | null;
}

interface StoredLap {
  /** The lap file as the server sent it: gzip. */
  bytes: Uint8Array;
}

const keyOf = (userId: string, lapId: string) => `${userId}|${lapId}`;
const ownedBy = (userId: string, key: IDBValidKey) => typeof key === 'string' && key.startsWith(`${userId}|`);

let lastTick = 0;
/** A clock that never repeats, so two laps used in the same millisecond still have an order. */
const tick = () => (lastTick = Math.max(Date.now(), lastTick + 1));

function fail(error: unknown, fallback: string): LibraryError {
  if (error instanceof LibraryError) return error;
  const text = `${(error as Error | null)?.name ?? ''} ${(error as Error | null)?.message ?? ''}`;
  if (/quota/i.test(text)) return new LibraryError('full', 'There is no room left on this device.');
  return new LibraryError('failed', fallback);
}

let legacyDropped = false;
function dropLegacy() {
  if (legacyDropped) return;
  legacyDropped = true;
  try {
    if (typeof indexedDB.deleteDatabase === 'function') indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    // Not there, or blocked: it is only left-over data.
  }
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new LibraryError('unavailable', 'This browser cannot keep laps on the device.'));
  dropLegacy();
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const name of [LAPS, META]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(fail(request.error, 'The lap cache could not be opened.'));
    } catch (error) {
      reject(fail(error, 'The lap cache could not be opened.'));
    }
  });
}

type Stores = { laps: IDBObjectStore; meta: IDBObjectStore };

/** One transaction over both stores. Resolves only when it has committed: a request succeeding is not enough, the commit can still fail. */
async function transact<T>(mode: IDBTransactionMode, work: (stores: Stores, done: (value: T) => void) => void): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let result: T;
    try {
      const tx = db.transaction([LAPS, META], mode);
      const finish = (error?: unknown) => {
        db.close();
        if (error === undefined) resolve(result);
        else reject(fail(error, 'The lap cache could not be updated.'));
      };
      tx.oncomplete = () => finish();
      tx.onerror = () => finish(tx.error ?? new Error('failed'));
      tx.onabort = () => finish(tx.error ?? new Error('failed'));
      work({ laps: tx.objectStore(LAPS), meta: tx.objectStore(META) }, (value) => {
        result = value;
      });
    } catch (error) {
      db.close();
      reject(fail(error, 'The lap cache could not be updated.'));
    }
  });
}

/** Every metadata record of one account (small: never the bytes), passed to `then` once the cursor has run out. */
function eachOwnMeta(userId: string, meta: IDBObjectStore, then: (records: Array<{ key: string; meta: LapMeta }>) => void) {
  const records: Array<{ key: string; meta: LapMeta }> = [];
  const request = meta.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      if (ownedBy(userId, cursor.key)) records.push({ key: cursor.key as string, meta: cursor.value as LapMeta });
      cursor.continue();
    } else then(records);
  };
}

/** Drops the least recently used laps of the account until it fits in the limits. */
function trim(userId: string, { laps, meta }: Stores) {
  eachOwnMeta(userId, meta, (records) => {
    let count = records.length;
    let bytes = records.reduce((sum, record) => sum + record.meta.size, 0);
    for (const record of records.sort((p, q) => p.meta.lastUsed - q.meta.lastUsed)) {
      if (count <= CACHE_LIMITS.maxLaps && bytes <= CACHE_LIMITS.maxBytes) break;
      meta.delete(record.key);
      laps.delete(record.key);
      count--;
      bytes -= record.meta.size;
    }
  });
}

/** The bytes of a cached lap, marking it as just used; undefined when it is not cached. */
async function readCached(userId: string, lapId: string): Promise<Uint8Array | undefined> {
  const key = keyOf(userId, lapId);
  return transact<Uint8Array | undefined>('readwrite', ({ laps, meta }, done) => {
    const found = laps.get(key);
    found.onsuccess = () => {
      const stored = found.result as StoredLap | undefined;
      if (!stored) return;
      done(stored.bytes);
      const record = meta.get(key);
      record.onsuccess = () => {
        const previous = record.result as LapMeta | undefined;
        if (previous) meta.put({ ...previous, lastUsed: tick() } satisfies LapMeta, key);
      };
    };
  });
}

async function store(userId: string, lapId: string, bytes: Uint8Array, sessionId: string | null): Promise<void> {
  const key = keyOf(userId, lapId);
  await transact<void>('readwrite', (stores) => {
    stores.laps.put({ bytes } satisfies StoredLap, key);
    stores.meta.put({ userId, lapId, size: bytes.byteLength, lastUsed: tick(), sessionId } satisfies LapMeta, key);
    trim(userId, stores);
  });
}

async function remove(userId: string, lapIds: readonly string[]): Promise<void> {
  if (lapIds.length === 0) return;
  await transact<void>('readwrite', ({ laps, meta }) => {
    for (const id of lapIds) {
      laps.delete(keyOf(userId, id));
      meta.delete(keyOf(userId, id));
    }
  });
}

const downloads = new Map<string, Promise<LapFile>>();

async function download(userId: string, lapId: string, sessionId: string | null): Promise<LapFile> {
  let blob: Blob;
  try {
    blob = await v1GetBlob(lapFilePath(lapId));
  } catch (error) {
    // A lap the server no longer has is not kept here either.
    if (error instanceof V1Error && error.status === 404) await remove(userId, [lapId]).catch(() => undefined);
    throw error;
  }
  // Strict: a file that is not a lap, or is too big, throws a LapReadError and is never kept.
  const lap = await readLapFile(blob);
  const bytes = await bytesOf(blob);
  // Keeping it is a convenience: a full or unavailable device still shows the lap.
  await store(userId, lapId, bytes, sessionId).catch(() => undefined);
  return lap;
}

/**
 * A lap's samples by the id the server knows it by. A cached lap is read from the device; otherwise its file is downloaded once
 * (several screens asking at the same moment share one download), checked, kept and returned.
 * Throws a V1Error when the server cannot give it, a LapReadError when what it gave is not a lap.
 */
export async function openLap(userId: string, lapId: string, hint: { sessionId?: string | null } = {}): Promise<LapFile> {
  try {
    const cached = await readCached(userId, lapId);
    if (cached) {
      try {
        return await gunzipLap(cached);
      } catch {
        // A damaged copy is dropped and fetched again.
        await remove(userId, [lapId]).catch(() => undefined);
      }
    }
  } catch {
    // No usable cache (blocked, full, unavailable): the server is asked.
  }
  const key = keyOf(userId, lapId);
  let pending = downloads.get(key);
  if (!pending) {
    pending = download(userId, lapId, hint.sessionId ?? null).finally(() => downloads.delete(key));
    downloads.set(key, pending);
  }
  return pending;
}

/** Forgets laps (after they were deleted on the server). Never throws: the cache is only a convenience. */
export async function forgetLaps(userId: string, lapIds: readonly string[]): Promise<void> {
  await remove(userId, lapIds).catch(() => undefined);
}

/**
 * A session was read from the server with these laps: a cached lap of that session which is no longer among them was deleted
 * elsewhere, so it is dropped (it is never shown from the cache alone). Never throws.
 */
export async function reconcileSession(userId: string, sessionId: string, lapIds: readonly string[]): Promise<void> {
  const present = new Set(lapIds);
  await transact<void>('readwrite', ({ laps, meta }) => {
    eachOwnMeta(userId, meta, (records) => {
      for (const record of records) {
        if (record.meta.sessionId !== sessionId || present.has(record.meta.lapId)) continue;
        meta.delete(record.key);
        laps.delete(record.key);
      }
    });
  }).catch(() => undefined);
}

/** Forgets every cached lap of an account (signing out of a shared browser, "clear cache"). Never throws. */
export async function clearCache(userId: string): Promise<void> {
  await transact<void>('readwrite', ({ laps, meta }) => {
    eachOwnMeta(userId, meta, (records) => {
      for (const record of records) {
        meta.delete(record.key);
        laps.delete(record.key);
      }
    });
  }).catch(() => undefined);
}
