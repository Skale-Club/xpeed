import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFESTS = 'shared-trip-media';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

/** Manifests contain IDs, never public file paths. Every read checks the live share link. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'POST'].includes(req.method)) return reply({ error: 'method_not_allowed' }, 405);
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return reply({ error: 'invalid_link' }, 400);
  const url = process.env.VITE_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply({ error: 'media_sharing_unavailable' }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    let userId: string | undefined;
    if (req.method === 'POST') {
      const bearer = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      if (!bearer) return reply({ error: 'unauthorized' }, 401);
      const auth = await db.auth.getUser(bearer);
      if (auth.error || !auth.data.user) return reply({ error: 'unauthorized' }, 401);
      userId = auth.data.user.id;
    }
    const { data: report, error } = await db.from('shared_reports').select('id,session_id,user_id,expires_at').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!report || (report.expires_at && new Date(report.expires_at).getTime() <= Date.now()) || (userId && report.user_id !== userId)) return reply({ error: 'link_unavailable' }, 404);
    const path = `${report.user_id}/${id}.json`;
    if (req.method === 'POST') {
      const text = await req.text();
      if (text.length > 12_000) return reply({ error: 'too_many_attachments' }, 400);
      const body = JSON.parse(text);
      if (!Array.isArray(body.ids) || body.ids.length > 100 || body.ids.some((value: unknown) => typeof value !== 'string' || !UUID.test(value))) return reply({ error: 'invalid_attachments' }, 400);
      const ids: string[] = [...new Set<string>(body.ids)];
      const photos = ids.length ? await db.from('session_photos').select('id').eq('session_id', report.session_id).eq('user_id', userId!).in('id', ids) : { data: [], error: null };
      if (photos.error) throw photos.error;
      if (photos.data?.length !== ids.length) return reply({ error: 'invalid_attachments' }, 400);
      // Immutable snapshot: later uploads do not silently join an existing public link.
      const saved = await db.storage.from(MANIFESTS).upload(path, JSON.stringify({ ids }), { contentType: 'application/json', upsert: false });
      if (saved.error) throw saved.error;
      return reply({ ok: true });
    }
    // Storage can wrap a missing-object HTTP 400 as an opaque error in Edge runtimes.
    // List the exact filename first so an ordinary non-opted-in link stays empty.
    const existing = await db.storage.from(MANIFESTS).list(report.user_id, { search: `${id}.json`, limit: 1 });
    if (existing.error) throw existing.error;
    if (!existing.data?.some((file) => file.name === `${id}.json`)) return reply({ items: [] });
    const manifest = await db.storage.from(MANIFESTS).download(path);
    if (manifest.error) throw manifest.error;
    const { ids } = JSON.parse(await manifest.data.text());
    if (!Array.isArray(ids) || !ids.length) return reply({ items: [] });
    const photos = await db.from('session_photos').select('id,storage_path,caption,photo_type').eq('session_id', report.session_id).eq('user_id', report.user_id).in('id', ids.slice(0, 100));
    if (photos.error) throw photos.error;
    const lifetime = Math.max(1, Math.min(300, report.expires_at ? Math.floor((new Date(report.expires_at).getTime() - Date.now()) / 1000) : 300));
    const items = await Promise.all((photos.data ?? []).filter((photo) => photo.storage_path.startsWith(`${report.user_id}/${report.session_id}/`)).map(async (photo) => {
      const signed = await db.storage.from('session-photos').createSignedUrl(photo.storage_path, lifetime);
      if (signed.error) throw signed.error;
      return { id: photo.id, caption: photo.caption, photo_type: photo.photo_type, video: /\.(mp4|webm)$/i.test(photo.storage_path), url: signed.data.signedUrl };
    }));
    return reply({ items });
  } catch { return reply({ error: 'media_sharing_failed' }, 503); }
}
