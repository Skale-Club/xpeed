// Crash-safe copies of trips, kept in IndexedDB (trips can outgrow
// localStorage). Every trip has its own entry, from the first backup while it
// is being recorded until it is safely in the database, so a trip that could
// not be saved (no signal in a garage) is never overwritten by the next one.

import type { ScannerSample } from './session-csv';

export interface StoredTrip {
  /** Entry key; see tripKey(). */
  id: string;
  /** The car selected when the trip started. */
  carId: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Set once the trip is over and waiting to be saved. */
  endedAt?: number;
  columns: string[];
  samples: ScannerSample[];
  /** Confirmed fault codes (go in the CSV). */
  dtcs?: string[];
  /** The full fault-code reading of the drive (confirmed, pending, read worked). */
  faultCodes?: { stored: string[]; pending: string[]; checked: boolean };
}

const DB_NAME = 'xpeed-obd';
const STORE = 'trips';

/** One entry per trip, keyed by its start time. */
export const tripKey = (startedAt: number) => `trip-${startedAt}`;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).finally(() => db.close()) as Promise<T | null>;
}

export async function saveTripCopy(trip: StoredTrip): Promise<void> {
  await run('readwrite', (s) => s.put(trip, trip.id));
}

/** Every trip copy on this device, oldest first. */
export async function listTripCopies(): Promise<StoredTrip[]> {
  const db = await openDb();
  if (!db) return [];
  const found: StoredTrip[] = [];
  await new Promise<void>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        // Older app versions kept a single entry under "current", without an id.
        found.push({ ...(cursor.value as Omit<StoredTrip, 'id'>), id: String(cursor.key) });
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
  return found
    .filter((t) => Array.isArray(t.samples) && t.samples.length > 0 && typeof t.startedAt === 'number')
    .sort((a, b) => a.startedAt - b.startedAt);
}

export async function deleteTripCopy(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
