// Minimal in-memory IndexedDB for tests (jsdom has none): databases with
// key/value object stores, transactions that commit when their requests are
// done, cursors with delete, and failures you can switch on. Supports exactly
// what lib/obd/trip-store.ts uses.

type Listener = (() => void) | null;

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;
}

type StoreData = Map<string, unknown>;

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export interface FakeIdb {
  /** Make every later transaction abort (disk full, blocked storage…). */
  failTransactions(on: boolean): void;
  /** Raw contents of one store, for assertions. */
  dump(store: string): Record<string, unknown>;
  /** Number of transactions run so far. */
  transactions(): number;
  uninstall(): void;
}

export function installFakeIndexedDb(): FakeIdb {
  const databases = new Map<string, { version: number; stores: Map<string, StoreData> }>();
  let failing = false;
  let txCount = 0;

  class FakeTransaction {
    oncomplete: Listener = null;
    onerror: Listener = null;
    onabort: Listener = null;
    error: Error | null = null;
    private pending = 0;
    private finished = false;

    private snapshot: Map<string, StoreData>;

    constructor(private stores: Map<string, StoreData>, private names: string[]) {
      txCount++;
      // What an aborted transaction puts back.
      this.snapshot = new Map(names.map((n) => [n, new Map(stores.get(n))]));
      // Commit once no request is outstanding.
      queueMicrotask(() => this.settle());
    }

    private settle() {
      if (this.finished) return;
      if (this.pending > 0) return;
      // Give callbacks that issue further requests a chance first.
      queueMicrotask(() => {
        if (this.finished || this.pending > 0) return;
        this.finished = true;
        if (failing) {
          this.rollback();
          this.error = new Error('QuotaExceededError');
          this.onabort?.();
        } else {
          this.oncomplete?.();
        }
      });
    }

    private rollback() {
      for (const [name, data] of this.snapshot) this.stores.set(name, data);
    }

    abort() {
      this.finished = true;
      this.rollback();
      this.onabort?.();
    }

    /** Run a request's work, then its callbacks, as the browser does. */
    request<T>(run: () => T): FakeRequest<T> {
      const req = new FakeRequest<T>();
      this.pending++;
      queueMicrotask(() => {
        if (this.finished) return;
        req.result = run();
        req.onsuccess?.();
        this.pending--;
        this.settle();
      });
      return req;
    }

    objectStore(name: string) {
      if (!this.names.includes(name)) throw new Error(`NotFoundError: ${name}`);
      const data = this.stores.get(name)!;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const tx = this;
      return {
        put: (value: unknown, key: string) => tx.request(() => { data.set(key, clone(value)); return key; }),
        get: (key: string) => tx.request(() => clone(data.get(key))),
        delete: (key: string) => tx.request(() => { data.delete(key); return undefined; }),
        openCursor: () => {
          const keys = Array.from(data.keys()).sort();
          let i = -1;
          const req = new FakeRequest<unknown>();
          const step = () => {
            tx.pending++;
            queueMicrotask(() => {
              if (tx.finished) return;
              i++;
              if (i >= keys.length) {
                req.result = null;
              } else {
                const key = keys[i];
                req.result = {
                  key,
                  value: clone(data.get(key)),
                  continue: step,
                  delete: () => { data.delete(key); },
                };
              }
              req.onsuccess?.();
              tx.pending--;
              tx.settle();
            });
          };
          step();
          return req;
        },
      };
    }
  }

  const factory = {
    open(name: string, version = 1) {
      const req = new FakeRequest<unknown>();
      queueMicrotask(() => {
        let entry = databases.get(name);
        const upgrading = !entry || entry.version < version;
        if (!entry) {
          entry = { version, stores: new Map() };
          databases.set(name, entry);
        }
        const db = entry;
        entry.version = Math.max(entry.version, version);
        req.result = {
          objectStoreNames: { contains: (n: string) => db.stores.has(n) },
          createObjectStore: (n: string) => { db.stores.set(n, new Map()); },
          transaction: (names: string | string[]) => new FakeTransaction(db.stores, Array.isArray(names) ? names : [names]),
          close: () => undefined,
        };
        if (upgrading) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  const g = globalThis as unknown as { indexedDB?: unknown };
  const previous = g.indexedDB;
  g.indexedDB = factory;

  return {
    failTransactions: (on) => { failing = on; },
    dump: (store) => {
      const out: Record<string, unknown> = {};
      for (const db of databases.values()) db.stores.get(store)?.forEach((v, k) => { out[k] = v; });
      return out;
    },
    transactions: () => txCount,
    uninstall: () => { g.indexedDB = previous; },
  };
}
