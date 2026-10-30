import { createClient } from '@supabase/supabase-js';
import { validateFuelEntry } from '../src/lib/fuel-ledger';
import { parseCSV } from '../src/lib/csv-parser';
import { sessionProcessingPayload } from '../src/lib/session-processing';
import type { Session } from '../src/types/session';
import { calculateFuelMetrics } from '../src/lib/fuel-metrics';

export const config = { runtime: 'edge' };
const BUCKET = 'vehicle-fuel-records';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return reply({ error: 'method_not_allowed' }, 405);
  const query = new URL(req.url).searchParams, carId = query.get('carId') ?? '';
  if (!UUID.test(carId)) return reply({ error: 'invalid_car' }, 400);
  const url = process.env.VITE_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply({ error: 'unavailable' }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return reply({ error: 'unauthorized' }, 401);
    const auth = await db.auth.getUser(token);
    if (auth.error || !auth.data.user) return reply({ error: 'unauthorized' }, 401);
    const userId = auth.data.user.id;
    const car = await db.from('car_profiles').select('*').eq('id', carId).eq('user_id', userId).maybeSingle();
    if (car.error) throw car.error;
    if (!car.data) return reply({ error: 'car_unavailable' }, 404);
    const prefix = `${userId}/${carId}`;
    if (req.method === 'DELETE') {
      const id = query.get('id') ?? '';
      if (!UUID.test(id)) return reply({ error: 'invalid_record' }, 400);
      const removed = await db.storage.from(BUCKET).remove([`${prefix}/${id}.json`]);
      if (removed.error) throw removed.error;
      return reply({ ok: true });
    }
    if (req.method === 'POST') {
      const text = await req.text();
      if (text.length > 6000) return reply({ error: 'invalid_record' }, 400);
      let input;
      try { input = JSON.parse(text); } catch { return reply({ error: 'invalid_record' }, 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ error: 'invalid_record' }, 400);
      if (input.action === 'calculate' || input.action === 'reprocess') {
        if (!UUID.test(input.sessionId ?? '')) return reply({ error: 'invalid_trip' }, 400);
        const session = await db.from('sessions').select('*').eq('id', input.sessionId).eq('car_profile_id', carId).eq('user_id', userId).maybeSingle();
        if (session.error) throw session.error;
        if (!session.data) return reply({ error: 'trip_unavailable' }, 404);
        let csv = session.data.source_csv;
        if (session.data.source_file_path) {
          if (!session.data.source_file_path.startsWith(`${userId}/${carId}/`)) return reply({ error: 'invalid_source' }, 400);
          const file = await db.storage.from('session-csv').download(session.data.source_file_path);
          if (file.error) { if (!csv) throw file.error; }
          else if (file.data.size <= 25 * 1024 * 1024) csv = await file.data.text();
          else return reply({ error: 'source_too_large' }, 413);
        }
        if (csv && csv.length > 25 * 1024 * 1024) return reply({ error: 'source_too_large' }, 413);
        if (!csv) return reply({ error: 'original_unavailable' }, 409);
        if (input.action === 'reprocess') {
          const payload = sessionProcessingPayload(session.data as Session, car.data, csv);
          const userDb = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
          const processed = await userDb.rpc('reprocess_session', { p_session_id: input.sessionId, p_payload: payload });
          if (processed.error) throw processed.error;
          return reply({ fuel: payload.summary.fuel });
        }
        const fuel = calculateFuelMetrics(parseCSV(csv));
        // Compare-and-swap preserves analysis or other summary fields changed during calculation.
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await db.from('sessions').select('summary').eq('id', input.sessionId).eq('user_id', userId).maybeSingle();
          if (current.error) throw current.error;
          if (!current.data) return reply({ error: 'trip_unavailable' }, 404);
          const summary = current.data.summary;
          let update = db.from('sessions').update({ summary: { ...(summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {}), fuel } }).eq('id', input.sessionId).eq('user_id', userId);
          update = summary == null ? update.is('summary', null) : update.eq('summary', JSON.stringify(summary));
          const saved = await update.select('id');
          if (saved.error) throw saved.error;
          if (saved.data?.length) return reply({ fuel });
        }
        return reply({ error: 'trip_changed_try_again' }, 409);
      }
      if (!validateFuelEntry(input)) return reply({ error: 'invalid_record' }, 400);
      const intent = req.headers.get('idempotency-key');
      if (intent && !UUID.test(intent)) return reply({error:'invalid_intent'},400);
      const entry = { ...input, pricePerLitre: input.kind === 'fill' ? input.totalPaid! / input.litres : input.pricePerLitre, at: new Date(input.at).toISOString(), id: intent || crypto.randomUUID() };
      const saved = await db.storage.from(BUCKET).upload(`${prefix}/${entry.id}.json`, JSON.stringify(entry), { contentType: 'application/json', upsert: false });
      if (saved.error) {
        if (intent) {
          const previous=await db.storage.from(BUCKET).download(`${prefix}/${intent}.json`,{}, {cache:'no-store'});
          if(!previous.error) {
            const existing=JSON.parse(await previous.data.text());
            const keys=['kind','at','litres','pricePerLitre','totalPaid','currency','odometerKm','fullTank','source','region','sourceUrl','note'] as const;
            if(keys.every(key=>existing[key] === entry[key])) return reply(existing);
            return reply({error:'intent_conflict'},409);
          }
        }
        throw saved.error;
      }
      return reply(entry, 201);
    }
    const names: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await db.storage.from(BUCKET).list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
      if (page.error) throw page.error;
      names.push(...page.data.filter((file) => /^[0-9a-f-]+\.json$/i.test(file.name)).map((file) => file.name));
      if (page.data.length < 100) break;
      if (offset >= 10000) return reply({ error: 'too_many_records' }, 409);
    }
    const items = [];
    const unique = [...new Set(names)];
    for (let offset = 0; offset < unique.length; offset += 15) {
      const batch = await Promise.all(unique.slice(offset, offset + 15).map(async (name) => {
        const file = await db.storage.from(BUCKET).download(`${prefix}/${name}`);
        if (file.error) throw file.error;
        const value = JSON.parse(await file.data.text());
        if (!validateFuelEntry(value) || !('id' in value) || typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error('Invalid saved fuel record');
        return value;
      }));
      items.push(...batch);
    }
    return reply({ items: items.sort((a, b) => b.at.localeCompare(a.at)) });
  } catch { return reply({ error: 'fuel_request_failed' }, 503); }
}
