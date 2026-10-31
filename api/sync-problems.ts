import { createClient } from '@supabase/supabase-js';
import { createIssueReconciler } from '../src/lib/issue-reconciler-core';
import type { SessionFlag } from '../src/lib/insight-engine';
import type { AiWarning } from '../src/lib/ai-client';
import { savedFaultReadout } from '../src/lib/trip-inspection';
export const config = { runtime: 'edge' };
const headers = {
  'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });

/** Acknowledgements are versioned: a newer recheck can never be deleted by an older worker. */
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply({ error: 'unauthorized' }, 401);
  const url = process.env.VITE_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply({ error: 'unavailable' }, 503);
  const db = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const auth = await db.auth.getUser(token);
    if (auth.error || !auth.data.user) return reply({ error: 'unauthorized' }, 401);
    const userId = auth.data.user.id;
    const input = await req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ error: 'invalid_request' }, 400);
    let query = db.from('session_issue_jobs').select('*').eq('user_id', userId)
      .lte('retry_at', new Date().toISOString()).order('retry_at').order('created_at').limit(10);
    if (input.sessionId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.sessionId)) return reply({ error: 'invalid_session' }, 400);
      query = query.eq('session_id', input.sessionId);
    }
    const jobs = await query;
    if (jobs.error) throw jobs.error;
    const reconciler = createIssueReconciler(db);
    let synced = 0, pending = 0;
    for (const job of jobs.data ?? []) {
      try {
        const trip = await db.from('sessions').select('id,car_profile_id,session_start,uploaded_at,summary,active_dtcs,gemini_analysis')
          .eq('id', job.session_id).eq('user_id', userId).single();
        const flags = await db.from('session_flags').select('*').eq('session_id', job.session_id);
        if (trip.error || flags.error) throw trip.error || flags.error;
        const at = trip.data.session_start ?? trip.data.uploaded_at;
        await reconciler.reconcileIssues(job.session_id, job.car_profile_id, userId, flags.data as SessionFlag[], at, job.reprocessing, true);
        const codes = savedFaultReadout(trip.data.summary) ?? { stored: trip.data.active_dtcs ?? [], pending: [], checked: false };
        await reconciler.syncFaultCodes(job.car_profile_id, userId, codes, job.session_id, at, true, job.reprocessing);
        const analysis = trip.data.gemini_analysis;
        if (!trip.data.summary?.analysis_outdated && Array.isArray(analysis?.warnings)) {
          const warnings = analysis.warnings.filter((value: unknown) => value && typeof value === 'object'
            && ['key','title','meaning','action','urgency'].every(key=>typeof (value as Record<string,unknown>)[key]==='string'));
          await reconciler.syncAiWarnings(job.car_profile_id,userId,warnings as AiWarning[],job.session_id,at,true);
        }
        const ack = await db.from('session_issue_jobs').delete().eq('session_id', job.session_id)
          .eq('user_id', userId).eq('version', job.version).select('session_id');
        if (ack.error) throw ack.error;
        if (ack.data?.length) synced++; else pending++;
      } catch {
        pending++;
        // A failing old trip must not starve newer jobs in the next batch.
        await db.from('session_issue_jobs').update({ retry_at: new Date(Date.now() + 60_000).toISOString() })
          .eq('session_id', job.session_id).eq('user_id', userId).eq('version', job.version);
      }
    }
    return reply({ synced, pending });
  } catch { return reply({ error: 'problem_sync_unavailable' }, 503); }
}
