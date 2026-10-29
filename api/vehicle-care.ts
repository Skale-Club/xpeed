import { createClient } from '@supabase/supabase-js';
import { EMPTY_VEHICLE_CARE, validCare, type VehicleCare } from '../src/lib/vehicle-care';
export const config = { runtime: 'edge' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'PUT'].includes(req.method)) return reply({ error: 'method_not_allowed' }, 405);
  const carId = new URL(req.url).searchParams.get('carId') ?? '';
  if (!UUID.test(carId)) return reply({ error: 'invalid_car' }, 400);
  const url = process.env.VITE_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply({ error: 'unavailable' }, 503);
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply({ error: 'unauthorized' }, 401);
  const db = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const auth = await db.auth.getUser(token);
    if (auth.error || !auth.data.user) return reply({ error: 'unauthorized' }, 401);
    const userId = auth.data.user.id;
    const car = await db.from('car_profiles').select('id').eq('id', carId).eq('user_id', userId).maybeSingle();
    if (car.error) throw car.error;
    if (!car.data) return reply({ error: 'car_unavailable' }, 404);
    const settingKey = `vehicle-care:${carId}`;
    const saved = await db.from('app_settings').select('id,setting_value,updated_at').eq('setting_key', settingKey).eq('user_id', userId).maybeSingle();
    if (saved.error) throw saved.error;
    const current = saved.data?.setting_value ? JSON.parse(saved.data.setting_value) as VehicleCare : { ...EMPTY_VEHICLE_CARE };
    if (!validCare(current)) throw Error('Invalid stored care settings');
    const service = await db.from('maintenance_events').select('id,performed_at,odometer_km,created_at').eq('car_profile_id', carId).eq('user_id', userId).eq('event_type', 'oil_change').order('performed_at', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (service.error) throw service.error;
    if (req.method === 'GET') return reply({ state: current, revision: saved.data?.updated_at ?? null, lastOil: service.data });
    const text = await req.text();
    if (text.length > 4000) return reply({ error: 'invalid_record' }, 400);
    let input;
    try { input = JSON.parse(text); } catch { return reply({ error: 'invalid_record' }, 400); }
    if (!input || !validCare(input.state)) return reply({ error: 'invalid_record' }, 400);
    if (input.revision !== (saved.data?.updated_at ?? null)) return reply({ error: 'changed_reload' }, 409);
    const s = input.state as VehicleCare, now = new Date().toISOString();
    const state: VehicleCare = { odometerKm: s.odometerKm, odometerAt: s.odometerKm === current.odometerKm ? current.odometerAt : s.odometerKm === null ? null : now,
      oilDueKm: s.oilDueKm, oilDueDate: s.oilDueDate, warnBeforeKm: s.warnBeforeKm, warnBeforeDays: s.warnBeforeDays, enabled: s.enabled,
      oilPlanAt: s.oilDueKm !== current.oilDueKm || s.oilDueDate !== current.oilDueDate || s.enabled !== current.enabled ? now : current.oilPlanAt };
    const row = { setting_key: settingKey, setting_value: JSON.stringify(state), user_id: userId, encrypted: false };
    const result = saved.data
      ? await db.from('app_settings').update(row).eq('id', saved.data.id).eq('user_id', userId).eq('updated_at', saved.data.updated_at).select('updated_at').maybeSingle()
      : await db.from('app_settings').insert(row).select('updated_at').single();
    if (result.error?.code === '23505' || (!result.error && !result.data)) return reply({ error: 'changed_reload' }, 409);
    if (result.error) throw result.error;
    return reply({ state, revision: result.data!.updated_at, lastOil: service.data });
  } catch { return reply({ error: 'care_request_failed' }, 503); }
}
