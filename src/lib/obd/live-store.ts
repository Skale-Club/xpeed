// The numbers that change every cycle (a few times a second), kept out of React
// state: putting them there re-rendered every screen that reads the connection,
// even ones that only show its status. Components that show live numbers read
// them with useObdLive() (a useSyncExternalStore over this store).

export interface LiveSnapshot {
  /** Latest reading per channel header. */
  values: Record<string, number | null>;
  /** How long the last full read of the car took. */
  cycleMs: number | null;
  /** Samples recorded so far in the trip in progress. */
  samples: number;
  /** When the latest displayed cycle was received, not when React rendered. */
  receivedAt: number | null;
}

export interface LiveStore {
  get(): LiveSnapshot;
  set(patch: Partial<LiveSnapshot>): void;
  subscribe(listener: () => void): () => void;
}

/** One shared "no readings" object, so clearing twice isn't a change. */
export const NO_VALUES: Record<string, number | null> = {};

const EMPTY: LiveSnapshot = { values: NO_VALUES, cycleMs: null, samples: 0, receivedAt: null };

export function createLiveStore(): LiveStore {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(patch) {
      const next = { ...snapshot, ...patch };
      if (next.values === snapshot.values && next.cycleMs === snapshot.cycleMs && next.samples === snapshot.samples && next.receivedAt === snapshot.receivedAt) return;
      snapshot = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Shown while no provider is mounted around the component (never changes). */
export const EMPTY_LIVE: LiveStore = { get: () => EMPTY, set: () => undefined, subscribe: () => () => undefined };
