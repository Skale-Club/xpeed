import { supabase } from '@/integrations/supabase/client';

export interface RecordingIdentity { sessionId: string; userId: string; startedAt?: string }
export class RecordingConflictError extends Error {}
export class RecordingDeletedError extends Error {}

export { csvChecksum, recordedSessionId } from './recording-identity';

/** A completed receipt is authoritative only for the same owner, car and exact CSV. */
export async function hasRecordedReceipt(identity: RecordingIdentity, carId: string, checksum: string): Promise<boolean> {
  const { data, error } = await supabase.from('sessions').select('id, user_id, car_profile_id, summary').eq('id', identity.sessionId).maybeSingle();
  if (error) throw new Error(`Could not verify saved trip: ${error.message}`);
  if (!data) {
    const deleted = await supabase.from('session_deletions' as never).select('recording_id').eq('recording_id',identity.sessionId).eq('user_id',identity.userId).maybeSingle();
    if(deleted.error) throw new Error('Could not check recording deletion');
    if(deleted.data) throw new RecordingDeletedError('Recording intentionally deleted');
    return false;
  }
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
    if (error.message.includes('Recording intentionally deleted')) throw new RecordingDeletedError(error.message);
    if (error.message.includes('Recording conflicts')) throw new RecordingConflictError(error.message);
    throw new Error(`Could not save recorded trip: ${error.message}`);
  }
  if (typeof data !== 'boolean') throw new Error('The trip save did not return a completion receipt.');
  return data;
}
