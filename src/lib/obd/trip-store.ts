// Crash-safe copies of trips, kept in IndexedDB (trips can outgrow
// localStorage). Every trip has its own entry, from the first backup while it
// is being recorded until it is safely in the database, so a trip that could
// not be saved (no signal in a garage) is never overwritten by the next one.
//
// While a trip is recorded its samples are backed up in append-only chunks
// (appendTripSamples) so a long drive doesn't rewrite everything every few
// seconds; once the trip is over saveTripCopy() writes it whole, with the end
// time, and drops the chunks.

import type { ScannerSample } from './session-csv';

export interface StoredTrip {
  /** Entry key; see tripKey(). */
  id: string;
  /** The car selected when the trip started (null: none yet; the car chosen later gets it). */
  carId: string | null;
  /** The signed-in user who recorded it: a copy is only ever uploaded for that user. */
  userId?: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Set once the trip is over and waiting to be saved. */
  endedAt?: number;
  columns: string[];
  samples: ScannerSample[];
  /** Confirmed fault codes (go in the CSV). */
  dtcs?: string[];
  /** The full fault-code reading of the drive (confirmed, pending, read worked, which modules answered). */
  faultCodes?: { stored: string[]; pending: string[]; checked: boolean; complete?: boolean; permanent?: string[]; modules?: string[]; codeModules?: Record<string, string[]> };
}

/** Everything about a trip except its samples (those go in chunks while recording). */
export type StoredTripMeta = Omit<StoredTrip, 'samples' | 'endedAt'>;

interface Chunk {
  tripId: string;
  startIndex: number;
  samples: ScannerSample[];
}

const DB_NAME = 'xpeed-obd';
const DB_VERSION = 2;
const TRIPS = 'trips';
const CHUNKS = 'chunks';

/** One entry per trip, keyed by its start time. */
export const tripKey = (startedAt: number) => `trip-${startedAt}`;

/** Log a storage problem, except the plain absence of IndexedDB (nothing to report there). */
function warn(message: string, err: unknown) {
  if (typeof indexedDB !== 'undefined') console.warn(message, err);
}

const chunkKey = (tripId: string, startIndex: number) => `${tripId}#${String(startIndex).padStart(8, '0')}`;
const isChunkOf = (key: IDBValidKey, tripId: string) => typeof key === 'string' && key.startsWith(`${tripId}#`);

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TRIPS)) db.createObjectStore(TRIPS);
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open the trip store.'));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Run `work` in one transaction over both stores. Resolves only when the
 * transaction has committed (a request succeeding is not enough: the commit can
 * still fail, e.g. the disk is full), and rejects if it failed or aborted.
 */
async function transact<T>(mode: IDBTransactionMode, work: (trips: IDBObjectStore, chunks: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await openDb();
  if (!db) throw new Error('This device cannot keep trip copies (no IndexedDB).');
  return new Promise<T>((resolve, reject) => {
    let result: T;
    try {
      const tx = db.transaction([TRIPS, CHUNKS], mode);
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Trip store transaction failed.')); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Trip store transaction aborted.')); };
      work(tx.objectStore(TRIPS), tx.objectStore(CHUNKS), (value) => { result = value; });
    } catch (err) {
      db.close();
      reject(err);
    }
  });
}

/** Visit every entry of a store. */
function forEachEntry(store: IDBObjectStore, visit: (key: IDBValidKey, value: unknown, cursor: IDBCursorWithValue) => void) {
  const req = store.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    visit(cursor.key, cursor.value, cursor);
    cursor.continue();
  };
}

/** The samples of a trip: those written with its meta, then its chunks in order, without overlaps. */
function assemble(meta: Omit<StoredTrip, 'id'> & { id: string }, chunks: Chunk[]): StoredTrip {
  const samples = [...(meta.samples ?? [])];
  for (const chunk of [...chunks].sort((a, b) => a.startIndex - b.startIndex)) {
    const skip = Math.max(0, samples.length - chunk.startIndex);
    samples.push(...chunk.samples.slice(skip));
  }
  return { ...meta, samples };
}

/** Write a trip whole (finished, or a snapshot), replacing any chunks it had. Resolves false if it could not be stored. */
export async function saveTripCopy(trip: StoredTrip): Promise<boolean> {
  try {
    await transact<void>('readwrite', (trips, chunks) => {
      trips.put(trip, trip.id);
      forEachEntry(chunks, (key, _value, cursor) => { if (isChunkOf(key, trip.id)) cursor.delete(); });
    });
    return true;
  } catch (err) {
    warn('Could not keep a copy of the trip on this device:', err);
    return false;
  }
}

/**
 * Add samples recorded since the last backup (`startIndex` is how many were
 * already backed up). A copy that was already closed is left alone. Resolves
 * false if it could not be stored, so the caller sends the same samples again.
 */
export async function appendTripSamples(meta: StoredTripMeta, samples: ScannerSample[], startIndex: number): Promise<boolean> {
  try {
    await transact<void>('readwrite', (trips, chunks) => {
      const existing = trips.get(meta.id);
      existing.onsuccess = () => {
        const current = existing.result as StoredTrip | undefined;
        if (current?.endedAt != null) return; // finished meanwhile: the whole copy is already there
        const chunk: Chunk = { tripId: meta.id, startIndex, samples };
        chunks.put(chunk, chunkKey(meta.id, startIndex));
        trips.put({ ...meta, samples: [] }, meta.id);
      };
    });
    return true;
  } catch (err) {
    warn('Could not back up the trip in progress:', err);
    return false;
  }
}

/** Every trip copy on this device, oldest first. */
export async function listTripCopies(): Promise<StoredTrip[]> {
  try {
    const metas = new Map<string, StoredTrip>();
    const chunks = new Map<string, Chunk[]>();
    await transact<void>('readonly', (tripStore, chunkStore) => {
      forEachEntry(tripStore, (key, value) => {
        // Older app versions kept a single entry under "current", without an id.
        metas.set(String(key), { ...(value as Omit<StoredTrip, 'id'>), id: String(key) });
      });
      forEachEntry(chunkStore, (_key, value) => {
        const chunk = value as Chunk;
        chunks.set(chunk.tripId, [...(chunks.get(chunk.tripId) ?? []), chunk]);
      });
    });
    return Array.from(metas.values())
      .map((meta) => assemble(meta, chunks.get(meta.id) ?? []))
      .filter((t) => Array.isArray(t.samples) && t.samples.length > 0 && typeof t.startedAt === 'number')
      .sort((a, b) => a.startedAt - b.startedAt);
  } catch (err) {
    warn('Could not read the trip copies on this device:', err);
    return [];
  }
}

/** One trip copy, or null if it is gone (uploaded, or never stored). */
export async function getTripCopy(id: string): Promise<StoredTrip | null> {
  try {
    const read: { meta?: StoredTrip } = {};
    const found: Chunk[] = [];
    await transact<void>('readonly', (trips, chunks) => {
      const req = trips.get(id);
      req.onsuccess = () => { read.meta = req.result as StoredTrip | undefined; };
      forEachEntry(chunks, (key, value) => { if (isChunkOf(key, id)) found.push(value as Chunk); });
    });
    if (!read.meta) return null;
    return assemble({ ...read.meta, id }, found);
  } catch (err) {
    warn('Could not read a trip copy:', err);
    return null;
  }
}

export async function deleteTripCopy(id: string): Promise<boolean> {
  try {
    await transact<void>('readwrite', (trips, chunks) => {
      trips.delete(id);
      forEachEntry(chunks, (key, _value, cursor) => { if (isChunkOf(key, id)) cursor.delete(); });
    });
    return true;
  } catch (err) {
    warn('Could not remove a trip copy:', err);
    return false;
  }
}
