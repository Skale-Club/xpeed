import { describe, it, expect, vi, beforeEach } from 'vitest';

// A small scripted stand-in for the Supabase client, so a test can make single
// queries fail or race (the harness copy never does).
type Row = Record<string, unknown>;
type DbError = { message: string; code?: string } | null;

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Called before every call to the table; return an error to make that query fail. */
  failWhen: null as null | ((op: string, table: string, filters: string[]) => DbError),
  /** Runs once, right after the first select of a problem finds nothing (another save slipping in). */
  afterEmptySelect: null as null | (() => void),
  inserts: 0,
  seq: 0,
}));

vi.mock('@/integrations/supabase/client', () => {
  class Query implements PromiseLike<{ data: unknown; error: DbError }> {
    private filters: ((r: Row) => boolean)[] = [];
    private described: string[] = [];
    private mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    private payload: Row = {};
    private one: 'single' | 'maybe' | null = null;
    constructor(private table: string) {}
    select() { return this; }
    eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); this.described.push(`${col}=${String(v)}`); return this; }
    like(col: string, pattern: string) { const p = pattern.replace('%', ''); this.filters.push((r) => String(r[col]).startsWith(p)); this.described.push(`${col} like ${pattern}`); return this; }
    in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); this.described.push(`${col} in ${vs.join(',')}`); return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'single'; return this; }
    insert(p: Row) { this.mode = 'insert'; this.payload = p; return this; }
    update(p: Row) { this.mode = 'update'; this.payload = p; return this; }
    upsert(p: Row) { this.mode = 'upsert'; this.payload = p; return this; }
    private run() {
      const failure = db.failWhen?.(this.mode, this.table, this.described);
      if (failure) return { data: null, error: failure };
      const rows = db.rows.filter((r) => r.__table === this.table);
      if (this.mode === 'insert') {
        db.inserts += 1;
        const dupe = rows.find((r) => r.car_profile_id === this.payload.car_profile_id && r.canonical_key === this.payload.canonical_key);
        if (dupe) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        const row = { id: `i${++db.seq}`, recurrence_count: 0, ...this.payload, __table: this.table };
        db.rows.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (this.mode === 'update') {
        rows.filter((r) => this.filters.every((f) => f(r))).forEach((r) => Object.assign(r, this.payload));
        return { data: null, error: null };
      }
      if (this.mode === 'upsert') {
        db.rows.push({ ...this.payload, __table: this.table });
        return { data: null, error: null };
      }
      const found = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.one) {
        if (found.length === 0 && this.table === 'vehicle_issues' && db.afterEmptySelect) {
          const run = db.afterEmptySelect;
          db.afterEmptySelect = null;
          run();
        }
        return { data: found[0] ? { ...found[0] } : null, error: null };
      }
      return { data: found.map((r) => ({ ...r })), error: null };
    }
    then<A, B>(ok?: ((v: { data: unknown; error: DbError }) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null) {
      return Promise.resolve().then(() => this.run()).then(ok, fail);
    }
  }
  return { supabase: { from: (table: string) => new Query(table) } };
});

const issue = (key: string) => db.rows.find((r) => r.__table === 'vehicle_issues' && r.canonical_key === key);
const issuesFor = (key: string) => db.rows.filter((r) => r.__table === 'vehicle_issues' && r.canonical_key === key);

beforeEach(() => {
  db.rows = [];
  db.failWhen = null;
  db.afterEmptySelect = null;
  db.inserts = 0;
});

const warning = { key: 'engine_slow_warmup', title: 'Slow warm-up', meaning: 'It took long.', action: 'Ask for a check.', urgency: 'watch' as const };
const at = '2026-10-28T12:00:00.000Z';

describe('explicit code reading persistence', () => {
  it.each(['select', 'insert', 'update'])('reports %s failures to the caller in strict mode', async (operation) => {
    const { syncFaultCodes } = await import('./issue-reconciler');
    if (operation === 'update') db.rows.push({ __table: 'vehicle_issues', id: 'existing', car_profile_id: 'car', canonical_key: 'dtc:P0300', status: 'active', severity: 'warning', last_seen_at: at });
    db.failWhen = (op) => op === operation ? { message: 'offline' } : null;
    await expect(syncFaultCodes('car', 'user', { stored: ['P0300'], pending: [], checked: true, modules: ['7E0'] }, null, at, true)).rejects.toThrow('offline');
  });
  it('reports failure to persist a resolved code', async () => {
    const { syncFaultCodes } = await import('./issue-reconciler');
    db.rows.push({ __table: 'vehicle_issues', id: 'old', car_profile_id: 'car', canonical_key: 'dtc:P0300', status: 'active', last_seen_at: at, details: { source: 'dtc', modules: ['7E0'] } });
    db.failWhen = (op) => op === 'update' ? { message: 'offline' } : null;
    await expect(syncFaultCodes('car', 'user', { stored: [], pending: [], checked: true, modules: ['7E0'] }, null, at, true)).rejects.toThrow('offline');
  });
});

it('does not reopen a resolved problem when the same trip is reprocessed', async () => {
  const { reconcileIssues } = await import('./issue-reconciler');
  db.rows.push({ __table: 'vehicle_issues', id: 'fixed', car_profile_id: 'car', canonical_key: 'coolant_temp', status: 'resolved', severity: 'serious', title: 'Hot', last_seen_at: at, recurrence_count: 2 });
  await reconcileIssues('trip', 'car', 'u1', [{ canonical_key: 'coolant_temp', parameter_key: 'Coolant', severity: 'critical', message: 'Hot', evidence: { min: 120, max: 120, avg: 120, pct_out_of_range: 100, longest_streak_s: 40, first_time: 0, last_time: 40 } }], at, true);
  expect(issue('coolant_temp')).toMatchObject({ id: 'fixed', status: 'resolved', recurrence_count: 2 });
  expect(db.rows.filter(r => r.__table === 'vehicle_issue_occurrences')).toHaveLength(1);
});

describe('syncAiWarnings', () => {
  it('adds nothing when it cannot tell which warnings the owner already dismissed', async () => {
    const { syncAiWarnings } = await import('./issue-reconciler');
    // The owner marked this one as fixed earlier...
    db.rows.push({ __table: 'vehicle_issues', id: 'old', car_profile_id: 'car', canonical_key: 'ai:engine_slow_warmup', status: 'resolved', severity: 'warning', title: 'x', last_seen_at: at });
    // ...but the read of the dismissed list fails this time.
    db.failWhen = (op, table, filters) => (op === 'select' && table === 'vehicle_issues' && filters.some((f) => f.includes('in ')) ? { message: 'network down' } : null);
    await syncAiWarnings('car', 'u1', [warning], 's1', at);
    expect(issue('ai:engine_slow_warmup')).toMatchObject({ id: 'old', status: 'resolved' });
    expect(db.rows.filter((r) => r.__table === 'vehicle_issue_occurrences')).toHaveLength(0);
  });

  it('still skips what was dismissed when the read works', async () => {
    const { syncAiWarnings } = await import('./issue-reconciler');
    db.rows.push({ __table: 'vehicle_issues', id: 'old', car_profile_id: 'car', canonical_key: 'ai:engine_slow_warmup', status: 'ignored', severity: 'warning', title: 'x', last_seen_at: at });
    await syncAiWarnings('car', 'u1', [warning], 's1', at);
    expect(issue('ai:engine_slow_warmup')).toMatchObject({ status: 'ignored' });
  });
});

describe('creating a problem twice at once', () => {
  it('updates the row the other save created instead of failing on the unique key', async () => {
    const { syncFaultCodes } = await import('./issue-reconciler');
    // Between this save's look and its insert, another save creates the same problem.
    db.afterEmptySelect = () => {
      db.rows.push({ __table: 'vehicle_issues', id: 'other', car_profile_id: 'car', canonical_key: 'dtc:P0420', status: 'active', severity: 'serious', title: 'P0420', recurrence_count: 0, last_seen_at: '2026-10-28T11:00:00.000Z' });
    };
    await syncFaultCodes('car', 'u1', { stored: ['P0420'], pending: [], checked: true }, 's1', at);
    expect(issuesFor('dtc:P0420')).toHaveLength(1);
    expect(issue('dtc:P0420')).toMatchObject({ id: 'other', last_seen_at: at });
    // The occurrence is recorded against the row that exists
    expect(db.rows.find((r) => r.__table === 'vehicle_issue_occurrences')).toMatchObject({ issue_id: 'other', session_id: 's1' });
  });
});
