import { RecordingDeletedError } from '../recorded-session';
import { supabase } from '@/integrations/supabase/client';
import { publicAppUrl } from '../trips';
import { recordedSessionId } from '../recording-identity';
import type { StoredTrip, StoredTripMeta } from './trip-store';
async function request(carId: string, method = 'GET', body?: unknown, id?: string) {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw Error('Sign in to synchronize your trip');
  const response = await fetch(`${publicAppUrl()}/api/trip-checkpoints?carId=${encodeURIComponent(carId)}${id ? `&id=${id}` : ''}`, { method, headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (response.status === 410 && result.error === 'recording_deleted') throw new RecordingDeletedError();
  if (!response.ok) throw Error(result.error || 'Trip cloud synchronization failed');
  return result;
}
export async function checkpointTrip(meta: StoredTripMeta & { endedAt?: number; totalSamples?: number }, samples: StoredTrip['samples'], offset: number) {
  if (!meta.carId || !meta.userId) throw Error('Select your car and sign in to synchronize');
  const id = await recordedSessionId(meta.userId, meta.carId, meta.id);
  return (await request(meta.carId, 'POST', { ...meta, offset, samples }, id)).accepted as number;
}
export async function removeCloudRecording(carId: string, recordingId: string) { await request(carId, 'DELETE', undefined, recordingId); }
export async function removeCloudTrip(copy: Pick<StoredTrip, 'id' | 'userId' | 'carId'>) {
  if (copy.carId && copy.userId) await request(copy.carId, 'DELETE', undefined, await recordedSessionId(copy.userId, copy.carId, copy.id));
}
export async function finalizeCloudTrip(copy: StoredTrip): Promise<string> {
  if (!copy.carId || !copy.userId) throw Error('Missing trip owner');
  return (await request(copy.carId, 'POST', { action: 'finalize' }, await recordedSessionId(copy.userId, copy.carId, copy.id))).sessionId;
}
export async function recoverCloudTrips(carId: string): Promise<StoredTrip[]> {
  const result = await request(carId);
  const copies: StoredTrip[] = [];
  // Only explicitly ended trips are retried automatically. Another phone may
  // still be recording; a missing heartbeat alone never finalizes its trip.
  for (const item of result.items.filter((item: { endedAt?: number }) => item.endedAt)) {
    try { copies.push((await request(carId, 'GET', undefined, item.id)).trip); }
    catch (error) { console.warn('Trip checkpoint recovery deferred:', error); }
  }
  return copies;
}
