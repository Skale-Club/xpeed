import { supabase } from '@/integrations/supabase/client';

export interface RecordingIdentity { sessionId: string; userId: string; startedAt?: string }
export class RecordingConflictError extends Error {}

export async function csvChecksum(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** Millisecond recording identity, namespaced by its owner and car, across retries/devices. */
export async function recordedSessionId(userId: string, carId: string, tripId: string): Promise<string> {
  const hash = await csvChecksum(JSON.stringify(['xpeed-recording-v1', userId, carId, tripId]));
  // UUIDv8 reserves custom derivations (this one uses SHA-256).
  const hex = hash.slice(0, 12) + '8' + hash.slice(13, 16) + ((parseInt(hash[16], 16) & 3) | 8).toString(16) + hash.slice(17, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A completed receipt is authoritative only for the same owner, car and exact CSV. */
export async function hasRecordedReceipt(identity: RecordingIdentity, carId: string, checksum: string): Promise<boolean> {
  const { data, error } = await supabase.from('sessions').select('id, user_id, car_profile_id, summary').eq('id', identity.sessionId).maybeSingle();
  if (error) throw new Error(`Could not verify saved trip: ${error.message}`);
  if (!data) return false;
  const summary = data.summary as Record<string, unknown> | null;
  if (data.user_id !== identity.userId || data.car_profile_id !== carId || summary?.recording_complete !== true || summary.recording_checksum !== checksum) {
    throw new RecordingConflictError('An existing trip does not match this recording. Both copies have been preserved.');
  }
  return true;
}

/** The database locks this identity, publishes all derivatives together, or recognizes a prior commit. */
export async function storeRecordedSession(identity: RecordingIdentity, carId: string, checksum: string, filename: string, start: string | null, sourcePath: string | null, csv: string, payload: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await supabase.rpc('store_recorded_session' as never, {
    p_session_id: identity.sessionId, p_user_id: identity.userId, p_car_id: carId, p_checksum: checksum,
    p_filename: filename, p_start: start, p_source_path: sourcePath, p_source_csv: sourcePath ? null : csv, p_payload: payload,
  } as never);
  if (error) {
    if (error.message.includes('Recording conflicts')) throw new RecordingConflictError(error.message);
    throw new Error(`Could not save recorded trip: ${error.message}`);
  }
  if (typeof data !== 'boolean') throw new Error('The trip save did not return a completion receipt.');
  return data;
}
