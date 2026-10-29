// Run after deployment: node --env-file=.env scripts/verify-fuel.mjs
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const owner = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const must = r => { if (r.error) throw r.error; return r.data; };
let tripId, entryId, path, carId, userId;
try {
  const auth = must(await owner.auth.signInWithPassword({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }));
  userId = auth.user.id;
  carId = must(await owner.from('car_profiles').select('id').eq('user_id', userId).limit(1))[0].id;
  const endpoint = `${process.env.FUEL_TEST_URL || 'https://xpeed.skale.club'}/api/fuel?carId=${carId}`;
  const request = (method = 'GET', body, extra = '') => fetch(endpoint + extra, { method, headers: { Authorization: `Bearer ${auth.session.access_token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(endpoint)).status, 401, 'Anonymous fuel access was accepted');
  const foreign = await fetch(endpoint.replace(carId, crypto.randomUUID()), { headers: { Authorization: `Bearer ${auth.session.access_token}` } });
  assert.equal(foreign.status, 404, 'Unknown car accepted');
  const at = new Date(Date.now() - 60000).toISOString();
  const entry = { kind: 'fill', at, litres: 10, totalPaid: 30, pricePerLitre: 999, currency: 'USD', odometerKm: 100, fullTank: true, source: 'receipt', region: '', sourceUrl: '', note: 'Temporary integration verification' };
  const saved = await request('POST', entry); assert.equal(saved.status, 201, `Save returned ${saved.status}`);
  const item = await saved.json(); entryId = item.id; path = `${userId}/${carId}/${entryId}.json`;
  assert.equal(item.pricePerLitre, 3, 'Receipt unit price was not derived from actual payment');
  const listed = await request(); assert.equal(listed.status, 200); assert.ok((await listed.json()).items.some(x => x.id === entryId));
  const publicUrl = admin.storage.from('vehicle-fuel-records').getPublicUrl(path).data.publicUrl;
  assert.notEqual((await fetch(publicUrl)).status, 200, 'Private fuel record exposed publicly');
  const trip = must(await owner.from('sessions').insert({ car_profile_id: carId, source_filename: 'Temporary fuel verification.csv', source_csv: 'Time,Fuel rate (L/h),Vehicle speed (km/h)\n0,3.6,36\n10,3.6,36\n20,3.6,36', session_start: at, summary: { summaries: [], sentinel: 'preserve me' } }).select('id').single()); tripId = trip.id;
  const calc = await request('POST', { action: 'calculate', sessionId: tripId }); assert.equal(calc.status, 200, `Calculation returned ${calc.status}`);
  assert.ok(Math.abs((await calc.json()).fuel.litres - .02) < 1e-8);
  const summary = must(await owner.from('sessions').select('summary').eq('id',tripId).single()).summary;
  assert.equal(summary.sentinel, 'preserve me', 'Calculation overwrote unrelated summary fields');
  const reprocessed = await request('POST', { action: 'reprocess', sessionId: tripId }); assert.equal(reprocessed.status, 200, `Reprocess returned ${reprocessed.status}`);
  assert.equal((await reprocessed.json()).fuel.coverage, 1);
  const after = must(await owner.from('sessions').select('processing_version').eq('id',tripId).single()); assert.ok(after.processing_version.endsWith('processing-3'));
  assert.equal((await request('DELETE', undefined, `&id=${entryId}`)).status, 200); entryId = null;
  console.log('Fuel integration passed: ownership, private storage, receipt totals, CRUD, full-resolution calculation, summary preservation and atomic reprocessing.');
} finally {
  if (path) must(await admin.storage.from('vehicle-fuel-records').remove([path]));
  if (tripId) must(await admin.from('sessions').delete().eq('id',tripId));
  await owner.auth.signOut({ scope: 'local' });
  console.log('Temporary fuel verification data removed.');
}
