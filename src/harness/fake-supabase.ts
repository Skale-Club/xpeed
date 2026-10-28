// In-memory stand-in for the Supabase client, used only by the screen-test
// copy of the app (vite.harness.config.ts aliases '@/integrations/supabase/client'
// here). Supports the query-builder calls the app makes, auth, RPCs, edge
// functions and storage, with seed data from ./seed. Also plugs in the
// simulated Bluetooth car. Never part of the real build.

import { HARNESS_USER, seedDatabase } from './seed';
import { installHarnessCar } from './fake-bluetooth';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

// Kept in localStorage so data survives page reloads; add ?reset to start over.
const DB_KEY = 'harness.db';
function loadDb(): Record<string, Row[]> {
  try {
    if (new URLSearchParams(window.location.search).has('reset')) localStorage.removeItem(DB_KEY);
    const saved = localStorage.getItem(DB_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // fall through to fresh seed
  }
  return seedDatabase();
}
const db = loadDb();
const persist = () => {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { /* too big: keep in memory only */ }
};
(window as unknown as { __harnessDb: typeof db }).__harnessDb = db;
let loggedIn = !new URLSearchParams(window.location.search).has('loggedout') && localStorage.getItem('harness.loggedOut') !== '1';
const authListeners = new Set<(event: string, session: unknown) => void>();

const session = () => (loggedIn ? { access_token: 'harness', token_type: 'bearer', user: HARNESS_USER } : null);
const emitAuth = (event: string) => authListeners.forEach((cb) => cb(event, session()));
let seq = 0;
const newId = () => `h-${Date.now().toString(36)}-${++seq}`;

class Query implements PromiseLike<Result> {
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: Row | Row[] | null = null;
  private one: 'single' | 'maybe' | null = null;
  private countOnly = false;
  private wantCount = false;

  constructor(private table: string) {
    db[table] ??= [];
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.wantCount = !!opts?.count;
    this.countOnly = !!opts?.head;
    return this;
  }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => r[col] !== v); return this; }
  is(col: string, v: unknown) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  gte(col: string, v: string | number) { this.filters.push((r) => (r[col] as string | number) >= v); return this; }
  lte(col: string, v: string | number) { this.filters.push((r) => (r[col] as string | number) <= v); return this; }
  filter(col: string, op: string, v: unknown) { return op === 'neq' ? this.neq(col, v) : this.eq(col, v); }
  order(col: string, opts?: { ascending?: boolean }) { this.sort = { col, asc: opts?.ascending ?? true }; return this; }
  limit(n: number) { this.max = n; return this; }
  range(from: number, to: number) { this.max = to + 1; void from; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  insert(rows: Row | Row[]) { this.mode = 'insert'; this.payload = rows; return this; }
  upsert(rows: Row | Row[]) { this.mode = 'upsert'; this.payload = rows; return this; }
  update(patch: Row) { this.mode = 'update'; this.payload = patch; return this; }
  delete() { this.mode = 'delete'; return this; }

  private run(): Result {
    // From the console: __harnessOffline = true makes every query fail, like no signal.
    if ((window as unknown as { __harnessOffline?: boolean }).__harnessOffline) {
      return { data: null, error: { message: 'Failed to fetch (harness offline)' } };
    }
    const table = db[this.table];
    const match = (r: Row) => this.filters.every((f) => f(r));
    let out: Row[] = [];
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const r of list) {
        const now = new Date().toISOString();
        const row: Row = { id: newId(), created_at: now, user_id: HARNESS_USER.id, ...(this.table === 'sessions' ? { uploaded_at: now } : {}), ...r };
        if (this.table === 'car_profiles' && !row.name) row.name = [row.year, row.make, row.model].filter(Boolean).join(' ');
        if (this.table === 'vehicle_issues') { row.status ??= 'active'; row.recurrence_count ??= 0; }
        const existing = table.findIndex((t) => t.id === row.id);
        if (existing >= 0) table[existing] = { ...table[existing], ...row };
        else table.push(row);
        out.push(row);
      }
      persist();
    } else if (this.mode === 'update') {
      out = table.filter(match);
      out.forEach((r) => Object.assign(r, this.payload));
      persist();
    } else if (this.mode === 'delete') {
      out = table.filter(match);
      db[this.table] = table.filter((r) => !match(r));
      persist();
    } else {
      out = table.filter(match);
    }
    if (this.sort) {
      const { col, asc } = this.sort;
      out = [...out].sort((a, b) => ((a[col] as string) > (b[col] as string) ? 1 : -1) * (asc ? 1 : -1));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    const copy = out.map((r) => ({ ...r }));
    if (this.one === 'single') {
      return copy[0] ? { data: copy[0], error: null } : { data: null, error: { message: 'No rows', code: 'PGRST116' } };
    }
    if (this.one === 'maybe') return { data: copy[0] ?? null, error: null };
    return { data: this.countOnly ? null : copy, error: null, count: this.wantCount ? copy.length : null };
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    // Small delay so loading states show briefly, like a real network.
    return new Promise<Result>((resolve) => setTimeout(() => resolve(this.run()), 60)).then(ok, fail);
  }
}

const rpcs: Record<string, (args: Row) => unknown> = {
  is_admin_user: () => false,
  get_dashboard_stats: () => null,
  refresh_parameter_baselines: () => null,
  get_shared_report: () => {
    const s = db.sessions[0];
    return {
      session: s,
      car: db.car_profiles[0],
      flags: db.session_flags.filter((f) => f.session_id === s.id),
      active_dtcs: s.active_dtcs,
      gemini_analysis: s.gemini_analysis,
      expires_at: null,
    };
  },
};

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: session() }, error: null }),
    getUser: async () => ({ data: { user: loggedIn ? HARNESS_USER : null }, error: null }),
    onAuthStateChange: (cb: (event: string, s: unknown) => void) => {
      authListeners.add(cb);
      return { data: { subscription: { unsubscribe: () => authListeners.delete(cb) } } };
    },
    signInWithPassword: async () => {
      loggedIn = true;
      localStorage.removeItem('harness.loggedOut');
      emitAuth('SIGNED_IN');
      return { data: { user: HARNESS_USER, session: session() }, error: null };
    },
    // Phone sign-in: any number gets a code; "123456" is the right one.
    signInWithOtp: async () => ({ data: {}, error: null }),
    verifyOtp: async ({ token }: { token: string }) => {
      if (token !== '123456') return { data: { user: null, session: null }, error: { message: 'Token has expired or is invalid', code: 'otp_expired' } };
      loggedIn = true;
      localStorage.removeItem('harness.loggedOut');
      emitAuth('SIGNED_IN');
      return { data: { user: HARNESS_USER, session: session() }, error: null };
    },
    signOut: async () => {
      loggedIn = false;
      localStorage.setItem('harness.loggedOut', '1');
      emitAuth('SIGNED_OUT');
      return { error: null };
    },
    signInWithOAuth: async () => ({ data: null, error: { message: 'Not available in the screen-test copy' } }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    updateUser: async (attrs: { data?: Row }) => {
      Object.assign(HARNESS_USER.user_metadata, attrs.data ?? {});
      return { data: { user: HARNESS_USER }, error: null };
    },
  },
  from: (table: string) => new Query(table),
  rpc: async (name: string, args: Row = {}) => ({ data: rpcs[name]?.(args) ?? null, error: null }),
  functions: {
    invoke: async (name: string, opts?: { body?: Row }) => {
      // Handy from the console: what the app sent to the AI last.
      (window as unknown as { __lastAiCall: unknown }).__lastAiCall = { name, body: opts?.body };
      await new Promise((r) => setTimeout(r, 400));
      if (name === 'analyze-session') {
        return {
          data: {
            analysis: {
              summary: 'Viagem tranquila: motor e bateria híbrida dentro do normal.',
              key_findings: ['Temperatura do motor normal', 'Nenhum código de falha novo'],
              recommended_action: 'Nada a fazer agora.',
            },
          },
          error: null,
        };
      }
      if (name === 'chat') {
        const message = String(opts?.body?.message ?? '');
        return { data: { reply: `(resposta de exemplo) Você perguntou: "${message}". Pelos dados, seu Prius está bem, mas fique de olho na temperatura do motor.` }, error: null };
      }
      return { data: { ok: true }, error: null };
    },
  },
  storage: {
    from: () => ({
      getPublicUrl: () => ({ data: { publicUrl: '/favicon.ico' } }),
      upload: async (path: string) => ({ data: { path }, error: null }),
      remove: async () => ({ data: [], error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: '/favicon.ico' }, error: null }),
      download: async () => ({ data: new Blob(['Time (s)\n0']), error: null }),
    }),
  },
  channel: () => {
    const ch = { on: () => ch, subscribe: () => ch, unsubscribe: async () => 'ok' };
    return ch;
  },
  removeChannel: async () => 'ok',
};

installHarnessCar();
console.info('[harness] Fake Supabase + simulated car ready. Add ?loggedout to the URL to see the login screens.');
