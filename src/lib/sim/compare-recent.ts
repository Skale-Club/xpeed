// The comparisons a person made lately or saved, kept in this browser so Compare can offer them again as chips. A comparison is the two lap ids the
// address names (`?a=&b=`) and a label made when it was shown. Storage can be missing or throw (private windows, blocked site data): then nothing is kept
// and everything still works for this visit. Pure apart from the storage calls, which are wrapped.

/** What a chip says about a comparison, as data (the screen words it in the person's language): the track, and the number and time of each lap. */
export interface ComparisonInfo {
  track: string;
  aLap: number;
  aMs: number;
  /** The reference lap's number and time; null when the lap was measured against the personal best and that was not loaded when it was kept. */
  bLap: number | null;
  bMs: number | null;
}

export interface SavedComparison {
  a: string;
  /** The reference lap; null when the lap is measured against the personal best. */
  b: string | null;
  info: ComparisonInfo;
  at: number;
  pinned: boolean;
}

/** How many comparisons are remembered by themselves (the saved ones are kept besides these, up to MAX_PINNED). */
export const MAX_RECENT = 8;
export const MAX_PINNED = 12;

export const savedStorageKey = (userId: string | null) => `xpeed.sim.compare.saved.${userId ?? 'anon'}`;

const same = (p: Pick<SavedComparison, 'a' | 'b'>, q: Pick<SavedComparison, 'a' | 'b'>) => p.a === q.a && (p.b ?? null) === (q.b ?? null);

const validInfo = (value: unknown): value is ComparisonInfo => {
  const info = value as Partial<ComparisonInfo> | null;
  return !!info && typeof info.track === 'string' && typeof info.aLap === 'number' && typeof info.aMs === 'number' && (info.bLap === null || typeof info.bLap === 'number') && (info.bMs === null || typeof info.bMs === 'number');
};

const valid = (value: unknown): value is SavedComparison => {
  const item = value as Partial<SavedComparison> | null;
  return !!item && typeof item.a === 'string' && item.a !== '' && (item.b === null || typeof item.b === 'string') && validInfo(item.info) && typeof item.at === 'number' && typeof item.pinned === 'boolean';
};

/** Saved first, then the others, each newest first; the recent ones cut to MAX_RECENT and the saved ones to MAX_PINNED. */
export function order(items: readonly SavedComparison[]): SavedComparison[] {
  const newest = (p: SavedComparison, q: SavedComparison) => q.at - p.at;
  return [...items.filter((item) => item.pinned).sort(newest).slice(0, MAX_PINNED), ...items.filter((item) => !item.pinned).sort(newest).slice(0, MAX_RECENT)];
}

/** What is kept for this person: saved ones first, then the recent ones, newest first. Anything that is not a comparison is ignored. */
export function loadSaved(userId: string | null): SavedComparison[] {
  try {
    const raw = window.localStorage.getItem(savedStorageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? order(parsed.filter(valid)) : [];
  } catch {
    return [];
  }
}

function persist(userId: string | null, items: SavedComparison[]): void {
  try {
    window.localStorage.setItem(savedStorageKey(userId), JSON.stringify(items));
  } catch {
    /* not kept: the chips still work for this visit */
  }
}

/**
 * Remembers a comparison that was shown (it moves to the front when it was there; a saved one stays saved). Gives the list back even when it could
 * not be kept, so the chips show what was just compared whatever the storage does. `from` is the list on screen (what `loadSaved` gave, plus what was added since).
 */
export function remember(userId: string | null, from: readonly SavedComparison[], item: Pick<SavedComparison, 'a' | 'b' | 'info'>, now: number = Date.now()): SavedComparison[] {
  const current = from;
  const found = current.find((entry) => same(entry, item));
  const next = order([{ a: item.a, b: item.b ?? null, info: item.info, at: now, pinned: found?.pinned ?? false }, ...current.filter((entry) => !same(entry, item))]);
  persist(userId, next);
  return next;
}

/** Saves a comparison (or lets it go back to the recent ones), on top of what is in `from` (the list on screen, which holds what could not be kept). */
export function setPinned(userId: string | null, from: readonly SavedComparison[], item: Pick<SavedComparison, 'a' | 'b'>, pinned: boolean): SavedComparison[] {
  const next = order(from.map((entry) => (same(entry, item) ? { ...entry, pinned } : entry)));
  persist(userId, next);
  return next;
}

export function forget(userId: string | null, from: readonly SavedComparison[], item: Pick<SavedComparison, 'a' | 'b'>): SavedComparison[] {
  const next = from.filter((entry) => !same(entry, item));
  persist(userId, next);
  return next;
}

export const isCurrent = (item: Pick<SavedComparison, 'a' | 'b'>, a: string | null, b: string | null): boolean => !!a && same(item, { a, b });
