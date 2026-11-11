import { blobBytes, readTrackFile } from '@/lib/sim/read-track-file';
import { gunzipTrack, trackKey, trackKeyOf, type TrackFile } from '@/lib/sim/track-file';

/**
 * The track layouts a person keeps on this device, next to their laps but in a database of their own (so adding this
 * did not need a new version of the laps database). One entry per track and layout, tagged with the account that added
 * it; adding the same track again replaces it, so the newest layout file is the one that is used. Nothing here leaves
 * the device.
 */

const DB_NAME = 'xpeed-sim-tracks';
const DB_VERSION = 2;
const TRACKS = 'tracks';
/** Track names a game reports that a person tied to a kept layout by hand (a game can name a track unlike its folder). */
const LINKS = 'links';

export type TrackLibraryErrorCode = 'unavailable' | 'full' | 'failed';

export class TrackLibraryError extends Error {
  constructor(public readonly code: TrackLibraryErrorCode, message: string) {
    super(message);
    this.name = 'TrackLibraryError';
  }
}

/** What the list shows about a layout, without opening its points. */
export interface TrackSummary {
  game: string;
  trackName: string;
  variant?: string;
  title?: string;
  lengthM?: number;
  source: string;
  hasIdealLine: boolean;
  hasPitLane: boolean;
  hasEdges: boolean;
}

export interface LibraryTrack {
  /** Storage key: the account and the track. */
  id: string;
  fileName: string;
  addedAt: number;
  size: number;
  summary: TrackSummary;
}

interface StoredTrack extends Omit<LibraryTrack, 'size'> {
  userId: string;
  /** The layout file as it is stored: gzip. */
  bytes: Uint8Array;
}

export function summarizeTrack(track: TrackFile): TrackSummary {
  const { game, track: info, source } = track.header;
  return {
    game,
    trackName: info.name,
    ...(info.variant !== undefined ? { variant: info.variant } : {}),
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.lengthM !== undefined ? { lengthM: info.lengthM } : {}),
    source,
    hasIdealLine: !!track.fast,
    hasPitLane: !!track.pitlane,
    hasEdges: track.centerline.left.some((v) => !Number.isNaN(v)),
  };
}

const keyFor = (userId: string, track: TrackFile) => `${userId}|${trackKey(track)}`;
const ownedBy = (userId: string, key: IDBValidKey) => typeof key === 'string' && key.startsWith(`${userId}|`);

const listeners = new Set<() => void>();
/** Called after every change, so a screen showing the list can read it again. */
export function subscribeTrackLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const notify = () => listeners.forEach((listener) => listener());

function fail(error: unknown, fallback: string): TrackLibraryError {
  if (error instanceof TrackLibraryError) return error;
  const text = `${(error as Error | null)?.name ?? ''} ${(error as Error | null)?.message ?? ''}`;
  if (/quota/i.test(text)) return new TrackLibraryError('full', 'There is no room left on this device.');
  return new TrackLibraryError('failed', fallback);
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new TrackLibraryError('unavailable', 'This browser cannot keep tracks on the device.'));
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(TRACKS)) request.result.createObjectStore(TRACKS);
        if (!request.result.objectStoreNames.contains(LINKS)) request.result.createObjectStore(LINKS);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(fail(request.error, 'The track library could not be opened.'));
    } catch (error) {
      reject(fail(error, 'The track library could not be opened.'));
    }
  });
}

/** One transaction. Resolves only when it has committed. */
async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void, storeName = TRACKS): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let result: T;
    const finish = (error: unknown) => {
      db.close();
      reject(fail(error, 'The track library could not be updated.'));
    };
    try {
      const tx = db.transaction([storeName], mode);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => finish(tx.error);
      tx.onabort = () => finish(tx.error);
      work(tx.objectStore(storeName), (value) => {
        result = value;
      });
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Reads a track layout file and keeps it, replacing the one of the same track and layout. Throws a TrackReadError if the
 * file is not a track layout (see readTrackFile) or a TrackLibraryError if the device cannot keep it.
 */
export async function addTrackFile(userId: string, file: Blob, fileName?: string): Promise<{ id: string; track: TrackFile; replaced: boolean }> {
  const track = await readTrackFile(file);
  const id = keyFor(userId, track);
  const bytes = await blobBytes(file);
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const stored: StoredTrack = {
    id,
    userId,
    addedAt: Date.now(),
    fileName: fileName ?? (file as File).name ?? 'track.xtrk',
    summary: summarizeTrack(track),
    bytes: gzipped ? bytes : await gzipRaw(bytes),
  };
  const replaced = await transact<boolean>('readwrite', (store, done) => {
    const existing = store.get(id);
    existing.onsuccess = () => {
      done(existing.result !== undefined);
      store.put(stored, id);
    };
  });
  notify();
  return { id, track, replaced };
}

async function gzipRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }).pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every layout this account has kept, in no particular order. */
export async function listTracks(userId: string): Promise<LibraryTrack[]> {
  return transact<LibraryTrack[]>('readonly', (store, done) => {
    const tracks: LibraryTrack[] = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as StoredTrack;
      if (ownedBy(userId, cursor.key)) tracks.push({ id: value.id, fileName: value.fileName, addedAt: value.addedAt, size: value.bytes.byteLength, summary: value.summary });
      cursor.continue();
    };
    done(tracks);
  });
}

async function loadStored(id: string): Promise<TrackFile | null> {
  const stored = await transact<StoredTrack | undefined>('readonly', (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result as StoredTrack | undefined);
  }).catch(() => undefined);
  if (!stored) return null;
  try {
    return await gunzipTrack(stored.bytes);
  } catch {
    return null;
  }
}

/** A kept layout by its id (from listTracks); null if it is not there or belongs to another account. */
export async function loadTrack(userId: string, id: string): Promise<TrackFile | null> {
  return ownedBy(userId, id) ? loadStored(id) : null;
}

/**
 * The layout of a track, as a lap file names it: the one kept under that name, else the one the person tied that name
 * to. Null if there is none (or it cannot be read).
 */
export async function findTrack(userId: string, game: string, trackName: string, variant?: string | null): Promise<TrackFile | null> {
  const name = `${userId}|${trackKeyOf(game, trackName, variant)}`;
  const direct = await loadStored(name);
  if (direct) return direct;
  const linked = await transact<string | undefined>('readonly', (store, done) => {
    const request = store.get(name);
    request.onsuccess = () => done(request.result as string | undefined);
  }, LINKS).catch(() => undefined);
  return linked && ownedBy(userId, linked) ? loadStored(linked) : null;
}

/** Ties the name a game gives a track to a kept layout, so its laps find it from now on. Returns that layout. */
export async function linkTrack(userId: string, game: string, trackName: string, variant: string | null | undefined, trackId: string): Promise<TrackFile | null> {
  if (!ownedBy(userId, trackId)) return null;
  const layout = await loadStored(trackId);
  if (!layout) return null;
  await transact<void>('readwrite', (store) => {
    store.put(trackId, `${userId}|${trackKeyOf(game, trackName, variant)}`);
  }, LINKS);
  notify();
  return layout;
}

export async function removeTracks(userId: string, ids: readonly string[]): Promise<void> {
  const mine = ids.filter((id) => ownedBy(userId, id));
  if (mine.length === 0) return;
  await transact<void>('readwrite', (store) => {
    for (const id of mine) store.delete(id);
  });
  notify();
}
