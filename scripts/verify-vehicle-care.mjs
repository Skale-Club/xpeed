// node --env-file=.env scripts/verify-vehicle-care.mjs
// CARE_TEST_LOCAL=1 tests the local handler against the real database before deployment.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { mkdir, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const owner = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, options);
const anon = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, options);
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const must = result => { if (result.error) throw result.error; return result.data; };
let handler, compiled, carId, userId;
try {
  if (process.env.CARE_TEST_LOCAL === '1') {
    const { build } = await import('esbuild');
    compiled = path.resolve('node_modules/.cache/vehicle-care-verification.mjs');
    await mkdir(path.dirname(compiled), { recursive: true });
    await build({ entryPoints: ['api/vehicle-care.ts'], outfile: compiled, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    handler = (await import(pathToFileURL(compiled).href)).default;
  }
  const auth = must(await owner.auth.signInWithPassword({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }));
  userId = auth.user.id;
  carId = must(await owner.from('car_profiles').insert({ name: 'Temporary oil reminder verification' }).select('id').single()).id;
  const key = `vehicle-care:${carId}`;
  const base = process.env.CARE_TEST_URL || 'https://xpeed.skale.club';
  const request = (method = 'GET', body, authenticated = true, id = carId) => {
    const req = new Request(`${base}/api/vehicle-care?carId=${id}`, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${auth.session.access_token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return handler ? handler(req) : fetch(req);
  };
  assert.equal((await request('GET', undefined, false)).status, 401);
  const foreign = must(await admin.from('car_profiles').select('id').neq('user_id', userId).limit(1))[0];
  if (foreign) assert.equal((await request('GET', undefined, true, foreign.id)).status, 404);
  const initial = await request(); assert.equal(initial.status, 200, 'Loading the care settings failed');
  const empty = await initial.json(); assert.equal(empty.state.odometerKm, null);
  const state = { ...empty.state, odometerKm: 149500 * 1.609344, oilDueKm: 150000 * 1.609344, warnBeforeKm: 500 * 1.609344 };
  const write = await request('PUT', { state, revision: empty.revision }); assert.equal(write.status, 200, 'Saving care settings failed');
  const saved = await write.json();
  assert.equal(saved.state.odometerKm, state.odometerKm); assert.ok(saved.state.odometerAt); assert.ok(saved.state.oilPlanAt);
  assert.equal((await request('PUT', { state, revision: null })).status, 409, 'Stale write overwrote another device');
  assert.equal((await request('PUT', { state: { ...state, odometerKm: -1 }, revision: saved.revision })).status, 400);
  const stored = must(await owner.from('app_settings').select('id,setting_value').eq('setting_key', key).eq('user_id', userId).single());
  assert.equal(JSON.parse(stored.setting_value).odometerKm, state.odometerKm);
  assert.equal(must(await anon.from('app_settings').select('id').eq('id', stored.id)).length, 0, 'Care details were publicly readable');
  const service = must(await owner.from('maintenance_events').insert({ car_profile_id: carId, event_type: 'oil_change', performed_at: new Date().toISOString().slice(0, 10), odometer_km: Math.round(150000 * 1.609344), notes: 'Temporary verification' }).select('id').single());
  const refreshed = await request(); assert.equal(refreshed.status, 200); assert.equal((await refreshed.json()).lastOil.id, service.id);
  const last = await (await request()).json();
  const next = await request('PUT', { state: { ...last.state, odometerKm: 150000 * 1.609344, oilDueKm: 155000 * 1.609344 }, revision: last.revision });
  assert.equal(next.status, 200); assert.equal((await next.json()).state.oilDueKm, 155000 * 1.609344);
  console.log('Vehicle care integration passed: private account/car scope, durable mileage, conflict protection, oil history and next reminder.');
} finally {
  if (carId && userId) {
    must(await owner.from('app_settings').delete().eq('setting_key', `vehicle-care:${carId}`).eq('user_id', userId));
    must(await owner.from('car_profiles').delete().eq('id', carId));
  }
  await owner.auth.signOut({ scope: 'local' });
  if (compiled) await unlink(compiled);
  console.log('Temporary vehicle care verification data removed.');
}
