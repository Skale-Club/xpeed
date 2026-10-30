import { supabase } from '@/integrations/supabase/client';
import { publicAppUrl } from './trips';
import type { FuelEntry } from './fuel-ledger';
import type { FuelMetrics } from './fuel-metrics';
export async function fuelRequest(carId: string, method = 'GET', body?: unknown, id?: string, intent?: string) {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('Sign in to view fuel records');
  const response = await fetch(`${publicAppUrl()}/api/fuel?carId=${encodeURIComponent(carId)}${id ? `&id=${encodeURIComponent(id)}` : ''}`, { method, headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json', ...(intent ? {'Idempotency-Key':intent} : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status===409 ? 'fuel_intent_conflict' : 'Fuel request failed');
  return response.json();
}
export async function listFuelEntries(carId: string): Promise<FuelEntry[]> { return (await fuelRequest(carId)).items; }
export async function saveFuelEntry(carId: string, entry: Omit<FuelEntry, 'id'>, intent?: string): Promise<FuelEntry> { return fuelRequest(carId, 'POST', entry, undefined, intent); }
export async function deleteFuelEntry(carId: string, id: string) { return fuelRequest(carId, 'DELETE', undefined, id); }
export async function calculateSavedFuel(carId: string, sessionId: string): Promise<FuelMetrics> { return (await fuelRequest(carId, 'POST', { action: 'reprocess', sessionId })).fuel; }
