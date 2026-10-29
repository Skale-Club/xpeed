import { describe, it, expect, vi, beforeEach } from 'vitest';

type Result = { data?: unknown; error?: { message: string; code?: string } | null };

const h = vi.hoisted(() => {
  const state = {
    queue: [] as { table: string; result: unknown }[],
    calls: [] as { table: string; method: string; args: unknown[] }[],
  };
  const chain = (table: string, result: unknown) => {
    const proxy: unknown = new Proxy(function () { /* callable target */ }, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          state.calls.push({ table, method: prop, args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  const from = vi.fn((table: string) => {
    const i = state.queue.findIndex((q) => q.table === table);
    const result = i >= 0 ? state.queue.splice(i, 1)[0].result : { data: null, error: null };
    return chain(table, result);
  });
  return { state, from };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: h.from, auth: { getUser: vi.fn() }, storage: { from: vi.fn() }, rpc: vi.fn() },
}));

import {
  createSession, insertSessionRows, insertSessionFlags, getSessionRows, getSession, createCarProfile,
  replaceSessionFlags, updateCarProfile,
  getSessions, getSessionFlags, getFlagsForSessions,
} from './db';
import { upsertAdminSetting } from './db-extras';

const queue = (table: string, result: Result) => h.state.queue.push({ table, result });
const callsOf = (table: string, method: string) =>
  h.state.calls.filter((c) => c.table === table && c.method === method);

beforeEach(() => {
  h.state.queue.length = 0;
  h.state.calls.length = 0;
  h.from.mockClear();
});

describe('trip reads preserve the database contract', () => {
  it('pages flags and bounds the list of trip IDs in each request', async () => {
    queue('session_flags', { data: Array.from({ length: 1000 }, (_, i) => ({ id: `f-${i}`, severity: 'critical' })), error: null });
    queue('session_flags', { data: [{ id: 'f-last', severity: 'attention' }], error: null });
    queue('session_flags', { data: [{ id: 'f-other', severity: 'critical' }], error: null });
    const flags = await getFlagsForSessions(Array.from({ length: 101 }, (_, i) => `trip-${i}`));
    expect(flags).toHaveLength(1002);
    expect(callsOf('session_flags', 'in').map(c => (c.args[1] as string[]).length)).toEqual([100, 100, 1]);
    expect(callsOf('session_flags', 'range').map(c => c.args)).toEqual([[0, 999], [1000, 1999], [0, 999]]);
  });

  it('rejects a failed trip or flag read rather than reporting an empty healthy trip', async () => {
    for (const read of [() => getSessions('car'), () => getSession('trip'), () => getSessionFlags('trip')]) {
      queue('sessions', { data: null, error: { message: 'offline' } });
      queue('session_flags', { data: null, error: { message: 'offline' } });
      await expect(read()).rejects.toThrow(/offline/);
      h.state.queue.length = 0;
    }
  });

  it('includes DTCs and reads all pages without using a shifting offset', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `id-${i}`, uploaded_at: '2026-10-29T00:00:00Z', session_start: null, active_dtcs: ['P0300'] }));
    queue('sessions', { data: page, error: null });
    queue('sessions', { data: [{ id: 'last', uploaded_at: '2026-10-28T00:00:00Z', session_start: null }], error: null });
    const trips = await getSessions('car');
    expect(trips).toHaveLength(1001);
    expect(String(callsOf('sessions', 'select')[0].args[0])).toContain('active_dtcs');
    expect(callsOf('sessions', 'or')[0].args[0]).toContain('id.lt.id-999');
  });
});

describe('saving a trip fails loudly', () => {
  it('createSession throws when the database refuses the row', async () => {
    queue('sessions', { data: null, error: { message: 'new row violates row-level security policy' } });
    await expect(createSession('car-1', 'a.csv', 10, ['a'], {})).rejects.toThrow(/row-level security/);
  });

  it('createSession returns the new id', async () => {
    queue('sessions', { data: { id: 's-1' }, error: null });
    await expect(createSession('car-1', 'a.csv', 10, ['a'], {})).resolves.toMatchObject({ id: 's-1' });
  });

  it('insertSessionRows throws on the first failing chunk', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ t_seconds: i, t_timestamp: null, data: { a: i } }));
    queue('session_rows', { error: null });
    queue('session_rows', { error: { message: 'statement timeout' } });
    await expect(insertSessionRows('s-1', rows)).rejects.toThrow(/statement timeout/);
    expect(callsOf('session_rows', 'insert')).toHaveLength(2); // stops at the failure, no third chunk
  });

  it('insertSessionFlags throws when the database refuses the flags', async () => {
    queue('session_flags', { error: { message: 'permission denied' } });
    await expect(
      insertSessionFlags('s-1', [{ severity: 'critical', canonical_key: 'k', parameter_key: 'p', message: 'm', evidence: {} }]),
    ).rejects.toThrow(/permission denied/);
  });

  it('insertSessionFlags with nothing to save does not touch the database', async () => {
    await insertSessionFlags('s-1', []);
    expect(h.from).not.toHaveBeenCalled();
  });
});

describe('getSessionRows', () => {
  const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, t_seconds: from + i }));

  it('reads past the 1000-row API limit', async () => {
    queue('session_rows', { data: page(1000), error: null });
    queue('session_rows', { data: page(1000, 1000), error: null });
    queue('session_rows', { data: page(5, 2000), error: null });
    const rows = await getSessionRows('s-1');
    expect(rows).toHaveLength(2005);
    expect(callsOf('session_rows', 'range').map((c) => c.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('stops after a short first page', async () => {
    queue('session_rows', { data: page(12), error: null });
    expect(await getSessionRows('s-1')).toHaveLength(12);
    expect(callsOf('session_rows', 'range')).toHaveLength(1);
  });

  it('throws instead of silently returning half a trip', async () => {
    queue('session_rows', { data: page(1000), error: null });
    queue('session_rows', { data: null, error: { message: 'boom' } });
    await expect(getSessionRows('s-1')).rejects.toThrow(/boom/);
  });
});

describe('getSession', () => {
  it('asks for named columns, never * and never the stored CSV', async () => {
    queue('sessions', { data: { id: 's-1', source_file_path: 'u/c/file.csv' }, error: null });
    const session = await getSession('s-1');
    expect(session).toMatchObject({ id: 's-1' });
    const select = callsOf('sessions', 'select');
    expect(select).toHaveLength(1);
    const columns = String(select[0].args[0]);
    expect(columns).not.toContain('*');
    expect(columns).not.toContain('source_csv');
    expect(columns).toContain('active_dtcs');
  });

  it('only fetches the CSV text for old trips that have no stored file', async () => {
    queue('sessions', { data: { id: 's-2', source_file_path: null }, error: null });
    queue('sessions', { data: { source_csv: 'a,b\n1,2' }, error: null });
    const session = (await getSession('s-2')) as unknown as { source_csv: string };
    expect(session.source_csv).toBe('a,b\n1,2');
    expect(callsOf('sessions', 'select').map((c) => c.args[0])).toContain('source_csv');
  });
});

describe('cars', () => {
  it('leaves country out when it is not set (the column is NOT NULL DEFAULT US)', async () => {
    queue('car_profiles', { data: { id: 'c1' }, error: null });
    await createCarProfile({ name: 'My car' });
    const payload = callsOf('car_profiles', 'insert')[0].args[0] as Record<string, unknown>;
    expect('country' in payload).toBe(false);
  });

  it('sends country when it is set', async () => {
    queue('car_profiles', { data: { id: 'c1' }, error: null });
    await createCarProfile({ name: 'My car', country: 'BR' });
    const payload = callsOf('car_profiles', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.country).toBe('BR');
  });

  it('never tries to null the country on update', async () => {
    queue('car_profiles', { error: null });
    await updateCarProfile('c1', { name: 'New name', country: null });
    const payload = callsOf('car_profiles', 'update')[0].args[0] as Record<string, unknown>;
    expect(payload).toEqual({ name: 'New name' });
  });
});

describe('replaceSessionFlags', () => {
  const flag = { severity: 'critical', canonical_key: 'coolant_temp', parameter_key: 'Coolant', message: 'Hot', evidence: {} };

  it('keeps the old flags when saving the new ones fails', async () => {
    queue('session_flags', { data: [{ id: 'old-1' }], error: null }); // read the old ones
    queue('session_flags', { data: null, error: { message: 'insert failed' } });
    await expect(replaceSessionFlags('s-1', [flag])).rejects.toThrow(/insert failed/);
    expect(callsOf('session_flags', 'delete')).toHaveLength(0);
  });

  it('saves the new flags before removing the old ones', async () => {
    queue('session_flags', { data: [{ id: 'old-1' }], error: null });
    queue('session_flags', { data: [{ id: 'new-1' }], error: null });
    queue('session_flags', { error: null });
    await replaceSessionFlags('s-1', [flag]);
    const order = h.state.calls.filter((c) => c.table === 'session_flags' && ['insert', 'delete'].includes(c.method)).map((c) => c.method);
    expect(order).toEqual(['insert', 'delete']);
    expect(callsOf('session_flags', 'in')[0].args).toEqual(['id', ['old-1']]);
  });

  it('removes the new flags again if clearing the old ones fails', async () => {
    queue('session_flags', { data: [{ id: 'old-1' }], error: null });
    queue('session_flags', { data: [{ id: 'new-1' }], error: null });
    queue('session_flags', { error: { message: 'delete failed' } });
    queue('session_flags', { error: null });
    await expect(replaceSessionFlags('s-1', [flag])).rejects.toThrow(/delete failed/);
    expect(callsOf('session_flags', 'in').map((c) => c.args)).toEqual([['id', ['old-1']], ['id', ['new-1']]]);
  });
});

describe('upsertAdminSetting', () => {
  it('updates the system row when it exists', async () => {
    queue('app_settings', { data: [{ id: 'a' }], error: null });
    await upsertAdminSetting('admin_openrouter_model', 'm');
    expect(callsOf('app_settings', 'insert')).toHaveLength(0);
    expect(callsOf('app_settings', 'is')[0].args).toEqual(['user_id', null]);
  });

  it('inserts when there is no system row (a user row with the same key does not count)', async () => {
    queue('app_settings', { data: [], error: null });
    queue('app_settings', { error: null });
    await upsertAdminSetting('admin_secret_openrouter_api_key', 'k');
    expect(callsOf('app_settings', 'insert')).toHaveLength(1);
  });

  it('retries the update when another save inserted the row first', async () => {
    queue('app_settings', { data: [], error: null });
    queue('app_settings', { error: { message: 'duplicate key', code: '23505' } });
    queue('app_settings', { data: [{ id: 'a' }], error: null });
    await expect(upsertAdminSetting('admin_openrouter_model', 'm')).resolves.toBeUndefined();
  });

  it('reports a real failure', async () => {
    queue('app_settings', { data: [], error: null });
    queue('app_settings', { error: { message: 'permission denied', code: '42501' } });
    await expect(upsertAdminSetting('admin_openrouter_model', 'm')).rejects.toMatchObject({ message: 'permission denied' });
  });
});
