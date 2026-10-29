// Explicit integration verification; creates and always removes a temporary owned trip.
// node --env-file=.env scripts/verify-trip-media.mjs [--local]
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
const local = process.argv.includes('--local') ? (await import('../api/shared-media.ts')).default : null;
const owner = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = (result) => { if (result.error) throw new Error(result.error.message); return result.data; };
const request = (url, options) => local ? local(new Request(url, options)) : fetch(url, options);
let tripId, reportId, userId;
const paths = [];
try {
  const auth = must(await owner.auth.signInWithPassword({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }));
  userId = auth.user.id;
  const cars = must(await owner.from('car_profiles').select('id').eq('user_id', userId).limit(1));
  assert.ok(cars.length, 'No owned car available for integration fixture');
  const trip = must(await owner.from('sessions').insert({ car_profile_id: cars[0].id, source_filename: 'Temporary media integration verification', session_start: new Date().toISOString(), duration_seconds: 0, row_count: 0, columns: [], summary: { summaries: [] } }).select('id').single());
  tripId = trip.id;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhNsAAAAASUVORK5CYII=', 'base64');
  async function addImage(caption) {
    const path = `${userId}/${tripId}/${crypto.randomUUID()}.png`; paths.push(path);
    must(await owner.storage.from('session-photos').upload(path, image, { contentType: 'image/png' }));
    return must(await owner.from('session_photos').insert({ session_id: tripId, storage_path: path, photo_type: 'dashboard', caption }).select('id').single());
  }
  const photo = await addImage('Temporary attachment verification');
  const report = must(await owner.from('shared_reports').insert({ session_id: tripId, expires_at: new Date(Date.now() + 600000).toISOString() }).select('id').single());
  reportId = report.id;
  const endpoint = `https://xpeed.skale.club/api/shared-media?id=${reportId}`;
  const noMedia = await request(endpoint); assert.equal(noMedia.status, 200, 'Empty opt-in state failed'); assert.equal((await noMedia.json()).items.length, 0);
  const noAuth = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [photo.id] }) }); assert.equal(noAuth.status, 401);
  const included = await request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${auth.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [photo.id] }) }); assert.equal(included.status, 200, 'Attachment inclusion failed');
  const publicView = await request(endpoint); assert.equal(publicView.status, 200); const payload = await publicView.json(); assert.equal(payload.items.length, 1); assert.equal(payload.items[0].caption, 'Temporary attachment verification');
  assert.equal((await fetch(payload.items[0].url)).status, 200, 'Public viewer could not read opted-in attachment');
  await addImage('Must stay private on existing link');
  assert.equal((await (await request(endpoint)).json()).items.length, 1, 'Future upload leaked into existing share');
  must(await owner.from('shared_reports').delete().eq('id', reportId));
  assert.equal((await request(endpoint)).status, 404, 'Revoked link still served media');
  console.log('Integration passed: opt-in, owner authentication, anonymous access, snapshot isolation and revocation.');
} finally {
  const cleanup = await Promise.allSettled([
    ...(reportId ? [admin.from('shared_reports').delete().eq('id', reportId).then(must), admin.storage.from('shared-trip-media').remove([`${userId}/${reportId}.json`]).then(must)] : []),
    ...(paths.length ? [admin.storage.from('session-photos').remove(paths).then(must)] : []),
    ...(tripId ? [admin.from('sessions').delete().eq('id', tripId).then(must)] : []),
  ]);
  assert.ok(cleanup.every((result) => result.status === 'fulfilled'), 'Temporary integration cleanup failed');
  console.log('Temporary integration records and files removed.');
}
