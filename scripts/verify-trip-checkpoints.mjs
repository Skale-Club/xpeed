// Uses disposable records in the configured test account; originals are never modified.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { recordedSessionId } from '../src/lib/recording-identity.ts';
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const owner = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const must = result => { if (result.error) throw result.error; return result.data; };
let userId, carId, id;
try {
  const auth = must(await owner.auth.signInWithPassword({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }));
  userId = auth.user.id;
  carId = must(await owner.from('car_profiles').select('id').eq('user_id', userId).limit(1))[0].id;
  const start = Date.now() - 60000;
  id = await recordedSessionId(userId, carId, `trip-${start}`);
  const base = `${process.env.CHECKPOINT_TEST_URL || 'https://xpeed.skale.club'}/api/trip-checkpoints?carId=${carId}`;
  const request = (method = 'GET', body, specific = true) => fetch(base + (specific ? `&id=${id}` : ''), { method, headers: { Authorization: `Bearer ${auth.session.access_token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base)).status, 401);
  const meta = { startedAt: start, columns: ['Vehicle speed (km/h)', 'Engine fuel rate (L/h)'], dtcs: [] };
  const samples = [0,10,20].map(t => ({ t, values: { 'Vehicle speed (km/h)': 36, 'Engine fuel rate (L/h)': 3.6 } }));
  assert.equal((await request('POST', { ...meta, offset: 0, samples: samples.slice(0,2) })).status, 200, 'Live checkpoint rejected');
  const active = await request();
  assert.equal(active.status, 200);
  assert.equal((await active.json()).trip.samples.length, 2, 'Active recording was not persisted');
  assert.equal(must(await owner.from('sessions').select('id').eq('id', id)).length, 0, 'Active trip was finalized prematurely');
  const duplicate = await request('POST', { ...meta, offset: 0, samples });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).accepted, 2, 'Retry did not confirm the original immutable chunk');
  assert.equal((await request('POST', { ...meta, offset: 0, samples: [{ t: 0, values: { 'Vehicle speed (km/h)': 99 } }] })).status, 409, 'Conflicting data overwrote a checkpoint');
  assert.equal((await request('POST', { action: 'finalize' })).status, 409, 'Active recording was finalized');
  assert.equal((await request('POST', { ...meta, offset: 2, samples: samples.slice(2) })).status, 200);
  assert.equal((await request('POST', { ...meta, offset: 3, samples: [], endedAt: start + 20000, totalSamples: 4 })).status, 200);
  assert.equal((await request('POST', { action: 'finalize' })).status, 503, 'Incomplete recording was published');
  assert.equal((await request('POST', { ...meta, offset: 3, samples: [], endedAt: start + 20000, totalSamples: 3 })).status, 200);
  const restored = await request();
  assert.deepEqual((await restored.json()).trip.samples, samples);
  const finished = await request('POST', { action: 'finalize' });
  assert.equal(finished.status, 200, `Finalization failed: ${await finished.clone().text()}`);
  assert.equal((await request('POST', { action: 'finalize' })).status, 200, 'Repeated finalization was not idempotent');
  const stored = must(await owner.from('sessions').select('summary,source_csv').eq('id', id).single());
  assert.equal(stored.summary.recording_complete, true);
  assert.ok(Math.abs(stored.summary.fuel.litres - .02) < 1e-8);
  assert.match(stored.source_csv, /Engine fuel rate/);
  const publicUrl = admin.storage.from('trip-checkpoints').getPublicUrl(`${userId}/${carId}/${id}/meta.json`).data.publicUrl;
  assert.notEqual((await fetch(publicUrl)).status, 200, 'Checkpoint was public');
  const listed = await request('GET', undefined, false);
  assert.ok(!(await listed.json()).items.some(item => item.id === id), 'Completed trip was queued twice');
  console.log('Cloud trip integration passed: incremental recording, immutable retries, gap detection, end marker, recovery, idempotent finalization and private storage.');
} finally {
  if (id && userId && carId) {
    const prefix = `${userId}/${carId}/${id}`;
    const files = must(await admin.storage.from('trip-checkpoints').list(prefix));
    if (files.length) must(await admin.storage.from('trip-checkpoints').remove(files.map(file => `${prefix}/${file.name}`)));
    must(await admin.from('sessions').delete().eq('id', id).eq('user_id', userId));
  }
  await owner.auth.signOut({ scope: 'local' });
  console.log('Disposable checkpoint verification records removed.');
}
