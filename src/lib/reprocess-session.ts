import { sessionProcessingPayload } from './session-processing';
import { supabase } from '@/integrations/supabase/client';
import { getCarById } from './db';
import { reconcileIssues } from './issue-reconciler';
import type { Session } from '@/types/session';

/** Read the original without changing its storage location or the trip's identity. */
export async function originalSessionCsv(session: Pick<Session, 'id' | 'source_file_path'> & { source_csv?: string | null }): Promise<string> {
  if (session.source_file_path) {
    const { data, error } = await supabase.storage.from('session-csv').download(session.source_file_path);
    if (!error && data) return data.text();
  }
  if (session.source_csv) return session.source_csv;
  const { data, error } = await supabase.from('sessions').select('source_csv').eq('id', session.id).maybeSingle();
  if (error) throw new Error(`Could not load original CSV: ${error.message}`);
  if (!data?.source_csv) throw new Error('The original CSV is unavailable. The trip has not been changed.');
  return data.source_csv;
}

/** Requires the additive reprocess_session migration. An unavailable RPC leaves the trip untouched. */
export async function reprocessStoredSession(session: Session & { source_csv?: string | null }): Promise<number> {
  const car = session.car_profile_id ? await getCarById(session.car_profile_id) : null;
  const payload = sessionProcessingPayload(session, car, await originalSessionCsv(session));
  const flags = payload.flags;
  const { error } = await supabase.rpc('reprocess_session' as never, { p_session_id: session.id, p_payload: payload } as never);
  if (error) throw new Error(`Could not recheck trip: ${error.message}`);
  // Existing problem decisions/history are preserved; only add genuinely seen flags.
  if (session.car_profile_id) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await reconcileIssues(session.id, session.car_profile_id, user.id, flags, session.session_start, true);
    } catch (error) { console.warn('Could not refresh problem occurrences after recheck:', error); }
  }
  return flags.length;
}
