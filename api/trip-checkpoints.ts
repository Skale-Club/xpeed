import { createClient } from '@supabase/supabase-js';
import { readCheckpointSamples } from '../src/lib/obd/checkpoint-samples';
import { recordedSessionId, csvChecksum } from '../src/lib/recording-identity';
import { sessionProcessingPayload } from '../src/lib/session-processing';
import { buildScannerCsv, scannerFilename } from '../src/lib/obd/session-csv';
import type { StoredTrip } from '../src/lib/obd/trip-store';
import type { Session } from '../src/types/session';
export const config = { runtime: 'edge' };
const BUCKET = 'trip-checkpoints';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET','POST','DELETE'].includes(req.method)) return reply({ error: 'method_not_allowed' }, 405);
  const query = new URL(req.url).searchParams, carId = query.get('carId') || '';
  if (!UUID.test(carId)) return reply({ error: 'invalid_car' }, 400);
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply({ error: 'unauthorized' }, 401);
  const url = process.env.VITE_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply({ error: 'checkpoint_unavailable' }, 503);
  const db = createClient(url, key, { auth: { persistSession: false } });
  try {
    const auth = await db.auth.getUser(token);
    if (auth.error || !auth.data.user) return reply({ error: 'unauthorized' }, 401);
    const userId = auth.data.user.id;
    const car = await db.from('car_profiles').select('*').eq('id', carId).eq('user_id', userId).maybeSingle();
    if (car.error) throw car.error;
    if (!car.data) return reply({ error: 'car_unavailable' }, 404);
    const root = `${userId}/${carId}`;
    const list = async (prefix: string) => {
      const files = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const result = await db.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        if (result.error) throw result.error;
        files.push(...result.data);
        if (result.data.length < 1000) return files;
      }
      throw Error('Checkpoint list limit reached');
    };
    const read = async (path: string) => {
      const result = await db.storage.from(BUCKET).download(path);
      if (result.error) throw result.error;
      return JSON.parse(await result.data.text());
    };
    const remove = async (id: string) => {
      const files = await list(`${root}/${id}`);
      if (files.length) { const result = await db.storage.from(BUCKET).remove(files.map(file => `${root}/${id}/${file.name}`)); if (result.error) throw result.error; }
    };
    const reconstruct = async (id: string): Promise<StoredTrip> => {
      const meta = await read(`${root}/${id}/meta.json`);
      const files = await list(`${root}/${id}`);
      const cutoff = meta.endedAt == null ? Infinity : (meta.endedAt - meta.startedAt) / 1000;
      const kept = await readCheckpointSamples(files.map(file => file.name), name => read(`${root}/${id}/${name}`), cutoff, meta.endedAt ? meta.totalSamples : undefined);
      return { ...meta, id: `trip-${meta.startedAt}`, userId, carId, samples: kept };
    };
    if (req.method === 'GET') {
      const id = query.get('id');
      if (id) { if (!UUID.test(id)) return reply({ error: 'invalid_recording' }, 400); return reply({ trip: await reconstruct(id) }); }
      const folders = (await list(root)).filter(file => UUID.test(file.name));
      const complete = new Set<string>();
      for (let offset = 0; offset < folders.length; offset += 100) {
        const saved = await db.from('sessions').select('id,summary').eq('user_id', userId).eq('car_profile_id', carId).in('id', folders.slice(offset,offset+100).map(folder => folder.name));
        if (saved.error) throw saved.error;
        for (const trip of saved.data) if (trip.summary?.recording_complete === true) complete.add(trip.id);
      }
      const items = [];
      for (const folder of folders) {
        if (complete.has(folder.name)) { await remove(folder.name).catch(() => {}); continue; }
        const files = await list(`${root}/${folder.name}`);
        if (!files.some(file => file.name === 'meta.json')) continue;
        const meta = await read(`${root}/${folder.name}/meta.json`);
        items.push({ id: folder.name, startedAt: meta.startedAt, endedAt: meta.endedAt, lastSeen: meta.lastSeen });
      }
      return reply({ items });
    }
    const id = query.get('id') || '';
    if (!UUID.test(id)) return reply({ error: 'invalid_recording' }, 400);
    if (req.method === 'DELETE') { await remove(id); return reply({ ok: true }); }
    const text = await req.text();
    if (text.length > 256 * 1024) return reply({ error: 'checkpoint_too_large' }, 413);
    let input; try { input = JSON.parse(text); } catch { return reply({ error: 'invalid_checkpoint' }, 400); }
    if (!input || typeof input !== 'object') return reply({ error: 'invalid_checkpoint' }, 400);
    if (input.action === 'finalize') {
      const trip = await reconstruct(id);
      if (!trip.endedAt || !trip.samples.length) return reply({ error: 'recording_not_finished' }, 409);
      const csv = buildScannerCsv(trip.columns, trip.samples, trip.dtcs || []);
      const start = new Date(trip.startedAt).toISOString(), filename = scannerFilename(new Date(trip.startedAt));
      const payload = sessionProcessingPayload({ id, source_filename: filename, session_start: start, gemini_analysis: null } as Session, car.data, csv);
      const userDb = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
      const preserved = { ...payload, summary: { ...payload.summary, faultCodes: trip.faultCodes ?? null } };
      const stored = await userDb.rpc('store_recorded_session', { p_session_id: id, p_user_id: userId, p_car_id: carId, p_checksum: await csvChecksum(csv), p_filename: filename, p_start: start, p_source_path: null, p_source_csv: csv, p_payload: preserved });
      if (stored.error) throw stored.error;
      return reply({ sessionId: id });
    }
    const { startedAt, offset, samples, columns, endedAt } = input;
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > Date.now() + 60000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 200000
      || !Array.isArray(samples) || samples.length > 200 || !Array.isArray(columns) || columns.length > 512 || columns.some(value => typeof value !== 'string' || value.length > 300)
      || (endedAt != null && (!Number.isSafeInteger(endedAt) || endedAt < startedAt || endedAt > Date.now() + 60000))) return reply({ error: 'invalid_checkpoint' }, 400);
    if (await recordedSessionId(userId, carId, `trip-${startedAt}`) !== id) return reply({ error: 'recording_identity_mismatch' }, 400);
    let previous = -1;
    for (const sample of samples) {
      if (!sample || !Number.isFinite(sample.t) || sample.t < previous || sample.t < 0 || sample.t > 604800 || !sample.values || typeof sample.values !== 'object' || Array.isArray(sample.values)
        || Object.entries(sample.values).some(([name,value]) => name.length > 300 || (value !== null && (typeof value !== 'number' || !Number.isFinite(value))))) return reply({ error: 'invalid_samples' }, 400);
      previous = sample.t;
    }
    let accepted = samples.length;
    if (samples.length) {
      const name = `${String(offset).padStart(9,'0')}.json`, path = `${root}/${id}/${name}`;
      const found = await db.storage.from(BUCKET).list(`${root}/${id}`, { search: name, limit: 1 });
      if (found.error) throw found.error;
      if (found.data.some(file => file.name === name)) {
        const existing = await read(path);
        const overlap = Math.min(existing.samples.length, samples.length);
        if (JSON.stringify(existing.samples.slice(0,overlap)) !== JSON.stringify(samples.slice(0,overlap))) return reply({ error: 'checkpoint_conflict' }, 409);
        accepted = existing.samples.length;
      } else {
        const result = await db.storage.from(BUCKET).upload(path, JSON.stringify({ offset, samples }), { contentType: 'application/json', upsert: false });
        if (result.error) throw result.error;
      }
    }
    if (endedAt != null && (!Number.isSafeInteger(input.totalSamples) || input.totalSamples < 1 || input.totalSamples > 200000)) return reply({ error: 'invalid_final_count' }, 400);
    const strings = (value: unknown) => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length <= 100).slice(0,100) : [];
    const faults = input.faultCodes && typeof input.faultCodes === 'object' ? {
      stored: strings(input.faultCodes.stored), pending: strings(input.faultCodes.pending), checked: input.faultCodes.checked === true,
      modules: strings(input.faultCodes.modules),
      codeModules: input.faultCodes.codeModules && typeof input.faultCodes.codeModules === 'object' ? Object.fromEntries(Object.entries(input.faultCodes.codeModules).slice(0,100).map(([code, modules]) => [code.slice(0,100), strings(modules)])) : {},
    } : undefined;
    const meta = { startedAt, faultCodes: faults, totalSamples: input.totalSamples ?? null, endedAt: endedAt ?? null, columns, dtcs: Array.isArray(input.dtcs) ? input.dtcs.filter((code: unknown) => typeof code === 'string').slice(0,100) : [], lastSeen: Date.now() };
    const saved = await db.storage.from(BUCKET).upload(`${root}/${id}/meta.json`, JSON.stringify(meta), { contentType: 'application/json', upsert: true });
    if (saved.error) throw saved.error;
    return reply({ accepted });
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'Cloud checkpoint failed';
    console.error('Trip checkpoint failed:', message.slice(0,500));
    return reply({ error: message.slice(0,500) }, 503);
  }
}
