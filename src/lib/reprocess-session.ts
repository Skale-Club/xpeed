import { supabase } from '@/integrations/supabase/client';
import { getCarById } from './db';
import { parseCSV } from './csv-parser';
import { computeParameterSummaries, evaluateRules } from './insight-engine';
import { resolveRulesetForCar } from './rule-resolver';
import { generateReport, PROCESSING_VERSION, REPORT_VERSION } from './report-generator';
import { sessionDuration, sessionTimes } from './session-time';
import { downsampleSessionRows } from './downsample';
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
  const parsed = parseCSV(await originalSessionCsv(session));
  if (!parsed.rows.length) throw new Error('The original CSV has no readings.');
  const car = session.car_profile_id ? await getCarById(session.car_profile_id) : null;
  const ruleset = resolveRulesetForCar(car);
  const summaries = computeParameterSummaries(parsed);
  const flags = evaluateRules(parsed, ruleset.rules);
  const durationSeconds = sessionDuration(parsed);
  const timeline = sessionTimes(parsed);
  const origin = timeline.find((value) => value !== null) ?? 0;
  const rows = downsampleSessionRows(parsed.rows.map((row, i) => ({
    t_seconds: parsed.timeColumn?.type === 'seconds' ? row[parsed.timeColumn.key] as number | null
      : parsed.timeColumn ? (timeline[i] == null ? null : timeline[i]! - origin) : i,
    t_timestamp: parsed.timeColumn?.type === 'timestamp' ? row[parsed.timeColumn.key] as string | null : null,
    data: Object.fromEntries(Object.entries(row).filter(([key, value]) => key !== parsed.timeColumn?.key && typeof value === 'number' && Number.isFinite(value))),
  })), 2000);
  const report = generateReport({
    sessionId: session.id, filename: session.source_filename, parsed, summaries, flags,
    durationSeconds, sessionStart: session.session_start, car,
    rulesetId: ruleset.id, rulesetMatchedVia: ruleset.matched_via,
  });
  const payload = {
    rows, flags, report, columns: parsed.headers, row_count: parsed.rows.length,
    duration_seconds: durationSeconds ?? null, active_dtcs: parsed.activeDtcs,
    summary: {
      summaries, headerMapping: parsed.headerMapping, timeColumn: parsed.timeColumn,
      rulesetId: ruleset.id, rulesetMatchedVia: ruleset.matched_via,
      // Preserve the original paid analysis in storage; do not present it as current.
      analysis_outdated: !!session.gemini_analysis,
    },
    ruleset_id: ruleset.id, ruleset_matched_via: ruleset.matched_via,
    report_version: REPORT_VERSION, processing_version: PROCESSING_VERSION,
  };
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
