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

describe('files', () => {
  it('uploads the bytes to the owner folder with the token and the file type', async () => {
    reply({ data: { path: 'u1/car.jpg' }, error: null });
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const result = await apiData.storage.from('car-photos').upload('u1/car.jpg', file, { contentType: 'image/jpeg', upsert: false });
    expect(result).toEqual({ data: { path: 'u1/car.jpg' }, error: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/storage/object/car-photos/u1/car.jpg?upsert=false');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer id-token', 'Content-Type': 'image/jpeg' });
    expect(init.body).toBe(file);
  });

  it('encodes odd characters in names and keeps the folder slashes', async () => {
    reply({ data: { path: 'x' }, error: null });
    await apiData.storage.from('session-photos').upload('u1/trip 1/café #2.png', new Blob(['x'], { type: 'image/png' }), { upsert: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/storage/object/session-photos/u1/trip%201/caf%C3%A9%20%232.png?upsert=true');
  });

  it('turns a refusal into the error the screens already read', async () => {
    reply({ data: null, error: { message: 'The resource already exists', code: 'already_exists', statusCode: '409' } }, 409);
    const result = await apiData.storage.from('car-photos').upload('u1/a.jpg', new Blob(['x']));
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ statusCode: '409', message: 'The resource already exists' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await apiData.storage.from('car-photos').remove(['u1/a.jpg'])).error?.message).toBe('Failed to fetch');
  });

  it('asks the server for a signed link and returns it as an absolute address', async () => {
    reply({ data: { signedPath: '/api/storage/object/car-photos/u1/a.jpg?token=abc' }, error: null });
    const result = await apiData.storage.from('car-photos').createSignedUrl('u1/a.jpg', 3600);
    expect(result.data?.signedUrl).toBe('/api/storage/object/car-photos/u1/a.jpg?token=abc');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ bucket: 'car-photos', path: 'u1/a.jpg', expiresIn: 3600 });
    h.native = true;
    reply({ data: { signedPath: '/api/storage/object/car-photos/u1/a.jpg?token=abc' }, error: null });
    expect((await apiData.storage.from('car-photos').createSignedUrl('u1/a.jpg', 60)).data?.signedUrl).toBe('https://xpeed.skale.club/api/storage/object/car-photos/u1/a.jpg?token=abc');
    reply({ data: null, error: { message: 'Object not found', statusCode: '404' } }, 404);
    expect((await apiData.storage.from('car-photos').createSignedUrl('u1/gone.jpg', 60)).error?.statusCode).toBe('404');
  });

  it('downloads a file as a Blob and reports a missing one', async () => {
    fetchMock.mockResolvedValueOnce(new Response('a,b;1,2', { status: 200 }));
    const found = await apiData.storage.from('session-csv').download('u1/t.csv');
    expect((found.data as Blob).size).toBe(7);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect((await apiData.storage.from('session-csv').download('u1/none.csv')).error).toMatchObject({ message: 'Object not found', statusCode: '404' });
  });

  it('builds the public address of a public asset', () => {
    expect(apiData.storage.from('brand-assets').getPublicUrl('logo.png').data.publicUrl).toBe('/api/storage/object/brand-assets/logo.png');
  });
});

describe('change notices', () => {
  it('calls back when the number of matching rows moves, not on the first look', async () => {
    vi.useFakeTimers();
    try {
      const seen = vi.fn();
      reply({ data: [], error: null, count: 3 });
      const channel = apiData.channel('sessions-car1').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sessions', filter: 'car_profile_id=eq.car1' }, seen).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ table: 'sessions', count: true, head: true, filters: [{ column: 'car_profile_id', op: 'eq', value: 'car1' }] });
      expect(seen).not.toHaveBeenCalled();
      reply({ data: [], error: null, count: 3 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seen).not.toHaveBeenCalled();
      reply({ data: [], error: null, count: 4 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seen).toHaveBeenCalledTimes(1);
      await apiData.removeChannel(channel);
      reply({ data: [], error: null, count: 9 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('withApiData', () => {
  it('replaces tables, functions, files and change notices but leaves edge functions and the rest alone', async () => {
    const storage = { from: vi.fn((_name: string) => 'bucket') };
    const original = { from: vi.fn(), rpc: vi.fn(), storage, channel: vi.fn(), functions: { invoke: vi.fn(() => 'ok') }, auth: { id() { return this === original.auth; } } };
    const client = withApiData(original);
    reply({ data: [], error: null });
    await client.from('car_profiles').select('id');
    expect(original.from).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.storage).toBe(apiData.storage);
    expect(client.functions.invoke()).toBe('ok');
    expect(client.channel).toBe(apiData.channel);
    expect(client.auth.id()).toBe(true);
  });
});
