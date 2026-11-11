import { gunzipLap, gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { readLapFile } from '@/lib/sim/read-lap-file';

/**
 * The laps a person keeps on this device. They live in IndexedDB (a lap is a few hundred KB, too much for
 * localStorage), one entry per lap, each tagged with the account that added it: another account on the same
 * browser never sees them. Nothing here leaves the device; when laps can be kept on the server this is where
 * they would be read from instead.
 */

const DB_NAME = 'xpeed-sim';
const DB_VERSION = 1;
const LAPS = 'laps';

export type LibraryErrorCode = 'unavailable' | 'full' | 'failed';

export class LibraryError extends Error {
  constructor(public readonly code: LibraryErrorCode, message: string) {
    super(message);
    this.name = 'LibraryError';
  }
}

/** What the list shows about a lap, without opening its samples. */
export interface LapSummary {
  game: string;
  trackName: string;
  trackLengthM?: number;
  carName: string;
  carClass?: string;
  lapNumber: number;
  timeMs: number;
  valid: boolean;
  sectorsMs?: number[];
  /** ISO 8601, UTC. */
  startedAt: string;
  sampleCount: number;
}

export interface LibraryLap {
  /** Storage key: the account and the identity of the lap. Safe to put in an address (after encoding). */
  id: string;
  fileName: string;
  /** Epoch ms. */
  addedAt: number;
  /** Bytes the lap takes on this device. */
  size: number;
  summary: LapSummary;
}

interface StoredLap extends Omit<LibraryLap, 'size'> {
  userId: string;
  /** The lap file as it is sent and stored: gzip. */
  bytes: Uint8Array;
}

export function summarize(lap: LapFile): LapSummary {
  const { game, track, car, lap: info, startedAt, sampleCount } = lap.header;
  return {
    game,
    trackName: track.name,
    ...(track.lengthM !== undefined ? { trackLengthM: track.lengthM } : {}),
    carName: car.name,
    ...(car.class !== undefined ? { carClass: car.class } : {}),
    lapNumber: info.number,
    timeMs: info.timeMs,
    valid: info.valid,
    ...(info.sectorsMs ? { sectorsMs: info.sectorsMs } : {}),
    startedAt,
    sampleCount,
  };
}

/** A lap is the same lap wherever the file came from: same game, track, car, start, lap number, time and length. */
export function lapIdentity(summary: LapSummary): string {
  return [summary.game, summary.trackName, summary.carName, summary.startedAt, summary.lapNumber, summary.timeMs, summary.sampleCount].join('|');
}

const keyFor = (userId: string, summary: LapSummary) => `${userId}|${lapIdentity(summary)}`;
const ownedBy = (userId: string, key: IDBValidKey) => typeof key === 'string' && key.startsWith(`${userId}|`);

const listeners = new Set<() => void>();
/** Called after every change, so a screen showing the list can read it again. */
export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const notify = () => listeners.forEach((listener) => listener());

function fail(error: unknown, fallback: string): LibraryError {
  if (error instanceof LibraryError) return error;
  const text = `${(error as Error | null)?.name ?? ''} ${(error as Error | null)?.message ?? ''}`;
  if (/quota/i.test(text)) return new LibraryError('full', 'There is no room left on this device.');
  return new LibraryError('failed', fallback);
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new LibraryError('unavailable', 'This browser cannot keep laps on the device.'));
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LAPS)) request.result.createObjectStore(LAPS);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(fail(request.error, 'The lap library could not be opened.'));
    } catch (error) {
      reject(fail(error, 'The lap library could not be opened.'));
    }
  });
}

/** One transaction. Resolves only when it has committed: a request succeeding is not enough, the commit can still fail. */
async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let result: T;
    try {
      const tx = db.transaction([LAPS], mode);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        reject(fail(tx.error, 'The lap library could not be updated.'));
      };
      tx.onabort = () => {
        db.close();
        reject(fail(tx.error, 'The lap library could not be updated.'));
      };
      work(tx.objectStore(LAPS), (value) => {
        result = value;
      });
    } catch (error) {
      db.close();
      reject(fail(error, 'The lap library could not be updated.'));
    }
  });
}

function eachEntry(store: IDBObjectStore, visit: (key: IDBValidKey, value: StoredLap, cursor: IDBCursorWithValue) => void) {
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    visit(cursor.key, cursor.value as StoredLap, cursor);
    cursor.continue();
  };
}

export type AddStatus = 'added' | 'duplicate';

/**
 * Reads a lap file and keeps it. A lap that is already there is not kept twice. Throws a LapReadError if the
 * file is not a lap (see readLapFile) or a LibraryError if the device cannot keep it.
 */
export async function addLapFile(userId: string, file: File | Blob, fileName?: string): Promise<{ status: AddStatus; id: string }> {
  const lap = await readLapFile(file);
  const summary = summarize(lap);
  const id = keyFor(userId, summary);
  const exists = await transact<boolean>('readonly', (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result !== undefined);
  });
  if (exists) return { status: 'duplicate', id };

  const bytes = await gzipLap(lap);
  const stored: StoredLap = { id, userId, addedAt: Date.now(), fileName: fileName ?? (file as File).name ?? 'lap.xlap.gz', summary, bytes };
  await transact<void>('readwrite', (store) => {
    store.put(stored, id);
  });
  notify();
  return { status: 'added', id };
}

/** Every lap this account has kept, in no particular order. */
export async function listLaps(userId: string): Promise<LibraryLap[]> {
  return transact<LibraryLap[]>('readonly', (store, done) => {
    const laps: LibraryLap[] = [];
    eachEntry(store, (key, value) => {
      if (!ownedBy(userId, key)) return;
      laps.push({ id: value.id, fileName: value.fileName, addedAt: value.addedAt, size: value.bytes.byteLength, summary: value.summary });
    });
    // The cursor finishes before the transaction completes; the value is read once it has.
    done(laps);
  });
}

/** The samples of a kept lap; null if it is not there (or belongs to another account). */
export async function loadLap(userId: string, id: string): Promise<LapFile | null> {
  if (!ownedBy(userId, id)) return null;
  const stored = await transact<StoredLap | undefined>('readonly', (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result as StoredLap | undefined);
  });
  if (!stored) return null;
  try {
    return await gunzipLap(stored.bytes);
  } catch {
    throw new LibraryError('failed', 'A kept lap could not be read.');
  }
}

export async function removeLaps(userId: string, ids: readonly string[]): Promise<void> {
  const mine = ids.filter((id) => ownedBy(userId, id));
  if (mine.length === 0) return;
  await transact<void>('readwrite', (store) => {
    for (const id of mine) store.delete(id);
  });
  notify();
}

/** Forgets every lap this account has kept. */
export async function clearLibrary(userId: string): Promise<void> {
  await transact<void>('readwrite', (store) => {
    eachEntry(store, (key, _value, cursor) => {
      if (ownedBy(userId, key)) cursor.delete();
    });
  });
  notify();
}
