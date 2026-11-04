import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: false, token: 'id-token' as string | null }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => h.token }));

import { apiData, apiOrigin, withApiData } from './api-data';

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
const sent = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);

beforeEach(() => { h.native = false; h.token = 'id-token'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('query builder', () => {
  it('sends a select with filters, cursor, order and window as data', async () => {
    reply({ data: [{ id: 'a' }], error: null });
    const result = await apiData.from('sessions').select('id, summary').eq('car_profile_id', 'c1').in('id', ['a', 'b'])
      .or('uploaded_at.lt.1,and(uploaded_at.eq.1,id.lt.z)').order('uploaded_at', { ascending: false }).order('id', { ascending: false }).limit(1000);
    expect(result).toEqual({ data: [{ id: 'a' }], error: null, count: null });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db');
    expect(sent()).toMatchObject({
      kind: 'query', table: 'sessions', action: 'select', select: 'id, summary', shape: 'many', limit: 1000,
      filters: [{ column: 'car_profile_id', op: 'eq', value: 'c1' }, { column: 'id', op: 'in', value: ['a', 'b'] }],
      or: ['uploaded_at.lt.1,and(uploaded_at.eq.1,id.lt.z)'],
      order: [{ column: 'uploaded_at', ascending: false }, { column: 'id', ascending: false }],
    });
  });

  it('turns range() into an offset and a limit, and count/head into flags', async () => {
    reply({ data: [], error: null, count: 7 });
    const result = await apiData.from('session_rows').select('id', { count: 'exact', head: true }).range(1000, 1999);
    expect(result.count).toBe(7);
    expect(sent()).toMatchObject({ offset: 1000, limit: 1000, count: true, head: true });
  });

  it('asks for the written row back only when select() follows a write', async () => {
    reply({ data: { id: 'n' }, error: null });
    await apiData.from('car_profiles').insert({ name: 'A' }).select('id').single();
    expect(sent()).toMatchObject({ action: 'insert', values: { name: 'A' }, returning: true, select: 'id', shape: 'single' });
    reply({ data: null, error: null });
    await apiData.from('car_profiles').insert([{ name: 'A' }, { name: 'B' }]);
    expect(sent()).toMatchObject({ action: 'insert', returning: false });
  });

  it('covers update, delete, upsert and match', async () => {
    reply({ data: null, error: null });
    await apiData.from('vehicle_issues').update({ status: 'resolved' }).eq('id', 'i1').neq('status', 'resolved').is('resolved_at', null);
    expect(sent()).toMatchObject({ action: 'update', values: { status: 'resolved' } });
    expect(sent().filters).toHaveLength(3);
    reply({ data: null, error: null });
    await apiData.from('session_flags').delete().match({ session_id: 's1', resolved: false });
    expect(sent()).toMatchObject({ action: 'delete', filters: [{ column: 'session_id', op: 'eq', value: 's1' }, { column: 'resolved', op: 'eq', value: false }] });
    reply({ data: null, error: null });
    await apiData.from('app_settings').upsert({ setting_key: 'k', value: 'v' }, { onConflict: 'setting_key', ignoreDuplicates: true });
    expect(sent()).toMatchObject({ action: 'upsert', onConflict: 'setting_key', ignoreDuplicates: true });
  });

  it('maybeSingle() and single() set the result shape', async () => {
    reply({ data: null, error: null });
    await apiData.from('sessions').select('id').eq('id', 'x').maybeSingle();
    expect(sent().shape).toBe('maybe');
  });
});

describe('rpc', () => {
  it('calls a function by name with named arguments', async () => {
    reply({ data: { page: 1 }, error: null });
    const result = await apiData.rpc('trip_page', { p_car: 'c', p_page: 1 });
    expect(result.data).toEqual({ page: 1 });
    expect(sent()).toEqual({ kind: 'rpc', name: 'trip_page', args: { p_car: 'c', p_page: 1 }, shape: 'many' });
    reply({ data: null, error: null });
    await apiData.rpc('is_admin_user');
    expect(sent().args).toEqual({});
  });
});

describe('transport', () => {
  it('sends the Google token, and none when signed out', async () => {
    reply({ data: [], error: null });
    await apiData.from('car_profiles').select('id');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer id-token');
    h.token = null;
    reply({ data: [], error: null });
    await apiData.from('car_profiles').select('id');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('keeps database errors as the app reads them (code, message)', async () => {
    reply({ data: null, error: { code: '23505', message: 'duplicate key value' } });
    const result = await apiData.from('vehicle_issues').insert({ id: 'x' });
    expect(result.error).toMatchObject({ code: '23505', message: 'duplicate key value' });
    expect(result.data).toBeNull();
  });

  it('reports a refused or failing request as an error instead of throwing', async () => {
    reply({ error: 'unauthorized' }, 401);
    expect((await apiData.from('car_profiles').select('id')).error).toMatchObject({ code: '401' });
    reply({ error: 'unavailable' }, 500);
    expect((await apiData.from('car_profiles').select('id')).error?.message).toMatch(/500/);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await apiData.from('car_profiles').select('id')).error?.message).toBe('Failed to fetch');
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect((await apiData.rpc('x')).error?.message).toMatch(/timeout/);
  });

  it('uses the production server from the installed Android app', async () => {
    h.native = true;
    expect(apiOrigin()).toBe('https://xpeed.skale.club');
    vi.stubEnv('VITE_APP_URL', 'https://example.test/');
    expect(apiOrigin()).toBe('https://example.test');
    reply({ data: [], error: null });
    await apiData.from('car_profiles').select('id');
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/api/db');
  });
});

describe('withApiData', () => {
  it('replaces from() and rpc() but leaves storage, functions and the rest of the client alone', async () => {
    const storage = { from: vi.fn((_name: string) => 'bucket') };
    const original = { from: vi.fn(), rpc: vi.fn(), storage, functions: { invoke: vi.fn(() => 'ok') }, removeChannel() { return this === original; } };
    const client = withApiData(original);
    reply({ data: [], error: null });
    await client.from('car_profiles').select('id');
    expect(original.from).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.storage.from('x')).toBe('bucket');
    expect(client.functions.invoke()).toBe('ok');
    expect(client.removeChannel()).toBe(true);
  });
});
