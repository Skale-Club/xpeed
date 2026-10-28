// Crash-safe copy of the trip being recorded, kept in IndexedDB (trips can
// outgrow localStorage). If the tab reloads mid-trip or saving fails, the
// next app start finds it here and saves it.

import type { ScannerSample } from './session-csv';

export interface StoredTrip {
  carId: string | null;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  columns: string[];
  samples: ScannerSample[];
}

const DB_NAME = 'xpeed-obd';
const STORE = 'trips';
const KEY = 'current';

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

export async function saveInProgressTrip(trip: StoredTrip): Promise<void> {
  await run('readwrite', (s) => s.put(trip, KEY));
}

export async function loadInProgressTrip(): Promise<StoredTrip | null> {
  const trip = await run<StoredTrip>('readonly', (s) => s.get(KEY));
  return trip && Array.isArray(trip.samples) ? trip : null;
}

export async function clearInProgressTrip(): Promise<void> {
  await run('readwrite', (s) => s.delete(KEY));
}
