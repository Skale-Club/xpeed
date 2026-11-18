import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSyntheticLap, exampleCorners } from '../src/lib/sim/synthetic-lap.ts';
import { gzipLap } from '../src/lib/sim/lap-file.ts';
import { loadDrivingEvidence, COACH_FILE_LIMITS } from '../supabase/functions/_shared/coach-laps.ts';
import { buildVirtualCoachPrompt, loadVirtualCoachContext } from '../supabase/functions/_shared/virtual-coach.ts';
import { fakeDb, fixture, ids, request } from './lib/virtual-coach-fixture.mjs';

async function pair() {
  const build = (lapNumber, slower) => {
    const corners = exampleCorners().map((c, i) => i === 0 && slower ? { ...c, brakeDist: c.brakeDist - 24, pickupDist: (c.pickupDist ?? c.apexDist + 25) + 24 } : c);
    const lap = buildSyntheticLap({ lengthM: 6000, corners, hz: 60, game: 'ac', trackName: 'Monza', car: 'Test GT3', lapNumber }).lap;
    lap.header.recorder = { app: 'xpeed-companion', version: '0.11.0', build: 'test-build', source: 'ac', gameBuild: 'test-game', coordinateFrame: 'world-xz-v1' };
    return lap;
  };
  const files = new Map(); const rows = fixture(); rows.sim_laps = [];
  for (const [number, slower] of [[1, false], [2, true]]) {
    const lap = build(number, slower), bytes = await gzipLap(lap), id = `70000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const path = `${ids.user}/${number}.xlap.gz`; files.set(path, new Blob([bytes]));
    rows.sim_laps.push({ id, user_id: ids.user, session_id: ids.session, game: lap.header.game, track_name: lap.header.track.name, car_name: lap.header.car.name,
      lap_number: number, time_ms: lap.header.lap.timeMs, sample_count: lap.header.sampleCount, started_at: lap.header.startedAt,
      storage_path: path, size_bytes: bytes.length, valid: true, plausible: true, in_lap: false, out_lap: false, sector_ms: null });
  }
  rows.sim_sessions[0].lap_count = 2;
  const db = fakeDb(rows), reads = [];
  db.storage = { from(bucket) { assert.equal(bucket, 'sim-laps'); return { async download(path) { reads.push(path); return { data: files.get(path), error: null }; } }; } };
  return { rows, files, db, reads };
}

test('loads only two owned matching files and exposes measured pair evidence in the coach', async () => {
  const f = await pair(); const { evidence } = await loadVirtualCoachContext(f.db, ids.user, request);
  assert.equal(f.reads.length, 2); assert.equal(evidence.driving.status, 'ready');
  assert.equal(evidence.driving.study.number, 2); assert.equal(evidence.driving.reference.number, 1);
  assert(evidence.driving.corners[0].brakePointM < -20);
  assert(evidence.driving.corners[0].throttlePickupM > 20);
  const prompt = buildVirtualCoachPrompt(evidence, 'English');
  assert(prompt.includes(evidence.driving.comparisonPath));
  assert(prompt.length < 14000);
  assert(!prompt.includes('storage_path')); assert(!prompt.includes('Float32Array'));
});

test('foreign paths and oversized metadata never cause a file read', async () => {
  for (const change of [
    (row) => { row.user_id = ids.other; },
    (row) => { row.storage_path = `${ids.other}/1.xlap.gz`; },
    (row) => { row.storage_path = `${ids.user}/../1.xlap.gz`; },
    (row) => { row.size_bytes = COACH_FILE_LIMITS.compressed + 1; },
    (row) => { row.sample_count = COACH_FILE_LIMITS.samples + 1; },
  ]) {
    const f = await pair(), study = { ...f.rows.sim_laps[1] }; change(study);
    assert.equal((await loadDrivingEvidence(f.db, ids.user, study, f.rows.sim_laps[0])).status, 'unavailable');
    assert.equal(f.reads.length, 0);
  }
});

test('storage corruption and metadata/header mismatches preserve metadata but withhold driving claims', async () => {
  for (const corrupt of [false, true]) {
    const f = await pair();
    if (corrupt) {
      const row = f.rows.sim_laps[1]; f.files.set(row.storage_path, new Blob([new Uint8Array(row.size_bytes)]));
    } else { f.rows.sim_laps[1].car_name = 'Another car'; }
    const { evidence } = await loadVirtualCoachContext(f.db, ids.user, request);
    assert.equal(evidence.driving.status, 'unavailable');
    assert.equal(evidence.insights.lapsUsed, 2);
    assert.equal(evidence.driving.corners, undefined);
    assert(f.reads.length <= 2);
  }
});

test('race comparison uses adjacent clean laps instead of an all-time or session fastest reference', async () => {
  const f = await pair(); f.rows.sim_sessions[0].kind = 'race';
  // Lap 3 has the same valid file as lap 2 but its identity is updated on disk.
  const lap = buildSyntheticLap({ lengthM: 6000, corners: exampleCorners(), game: 'ac', trackName: 'Monza', car: 'Test GT3', lapNumber: 3, hz: 60 }).lap;
  const bytes = await gzipLap(lap), path = `${ids.user}/3.xlap.gz`;
  f.files.set(path, new Blob([bytes]));
  f.rows.sim_laps.push({ ...f.rows.sim_laps[0], id: '70000000-0000-4000-8000-000000000003', lap_number: 3,
    storage_path: path, size_bytes: bytes.length, sample_count: lap.header.sampleCount, time_ms: lap.header.lap.timeMs, started_at: lap.header.startedAt });
  f.rows.sim_sessions[0].lap_count = 3;
  const { evidence } = await loadVirtualCoachContext(f.db, ids.user, request);
  assert.equal(evidence.driving.status, 'ready');
  assert.equal(evidence.driving.study.number, 3); assert.equal(evidence.driving.reference.number, 2);
});
