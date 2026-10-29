import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import handler from '../../api/shared-media';

const state = vi.hoisted(() => ({ report: null as null | { id: string; user_id: string; session_id: string; expires_at: string | null }, caller: 'owner', ids: null as string[] | null, photos: [] as { id: string; session_id: string; user_id: string; storage_path: string; caption: string; photo_type: string }[], signs: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: state.caller } }, error: null }) },
  from: (table: string) => {
    const filters: Record<string, string> = {};
    return { select() { return this; }, eq(key: string, value: string) { filters[key] = value; return this; },
      maybeSingle: async () => ({ data: state.report?.id === filters.id ? state.report : null, error: null }),
      in: async (_key: string, ids: string[]) => ({ data: table === 'session_photos' ? state.photos.filter((photo) => ids.includes(photo.id) && photo.session_id === filters.session_id && photo.user_id === filters.user_id) : [], error: null }),
    };
  },
  storage: { from: () => ({
    list: async () => ({ data: state.ids ? [{ name: `${state.report!.id}.json` }] : [], error: null }),
    download: async () => state.ids ? { data: { text: async () => JSON.stringify({ ids: state.ids }) }, error: null } : { data: null, error: { statusCode: 404 } },
    upload: async (_path: string, content: string) => { state.ids = JSON.parse(content).ids; return { error: null }; },
    createSignedUrl: async (path: string) => { state.signs(path); return { data: { signedUrl: 'https://example.supabase.co/signed' }, error: null }; },
  }) },
}) }));
const id = '11111111-1111-4111-8111-111111111111';
const photo = '22222222-2222-4222-8222-222222222222';
const request = (method = 'GET', ids = [photo]) => new Request(`https://xpeed.test/api/shared-media?id=${id}`, { method, ...(method === 'POST' ? { headers: { Authorization: 'Bearer token' }, body: JSON.stringify({ ids }) } : {}) });
beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
  state.report = { id, user_id: 'owner', session_id: 'trip', expires_at: null }; state.caller = 'owner'; state.ids = null; state.signs.mockClear();
  state.photos = [{ id: photo, session_id: 'trip', user_id: 'owner', storage_path: 'owner/trip/test.mp4', caption: 'Overheated', photo_type: 'engine_bay' }];
});
afterEach(() => vi.unstubAllEnvs());
it('shares an explicit snapshot with a valid public link and supports video', async () => {
  expect((await handler(request('POST'))).status).toBe(200);
  const response = await handler(request());
  expect(await response.json()).toMatchObject({ items: [{ id: photo, video: true, caption: 'Overheated' }] });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
it('does not expose attachments on links without an opted-in manifest', async () => {
  expect(await (await handler(request())).json()).toEqual({ items: [] });
  expect(state.signs).not.toHaveBeenCalled();
});
it('rejects another owner or a file from another trip', async () => {
  state.caller = 'other'; expect((await handler(request('POST'))).status).toBe(404);
  state.caller = 'owner'; state.photos[0].session_id = 'another-trip';
  expect((await handler(request('POST'))).status).toBe(400);
  expect(state.ids).toBeNull();
});
it('stops issuing URLs when a link is revoked or expired', async () => {
  state.ids = [photo]; state.report!.expires_at = '2020-01-01';
  expect((await handler(request())).status).toBe(404);
  state.report = null; expect((await handler(request())).status).toBe(404);
  expect(state.signs).not.toHaveBeenCalled();
});
