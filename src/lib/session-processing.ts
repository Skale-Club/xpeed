import { calculateFuelMetrics } from './fuel-metrics';
import { parseCSV } from './csv-parser';
import { computeParameterSummaries, evaluateRules } from './insight-engine';
import { resolveRulesetForCar } from './rule-resolver';
import { generateReport, PROCESSING_VERSION, REPORT_VERSION } from './report-generator';
import { sessionDuration, sessionTimes } from './session-time';
import { downsampleSessionRows } from './downsample';
import type { CarProfile } from './db';
import type { Session } from '@/types/session';
export function sessionProcessingPayload(session: Session, car: CarProfile | null, csv: string) {
  const parsed = parseCSV(csv);
  if (!parsed.rows.length) throw new Error('The original CSV has no readings.');
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
  return {
    rows, flags, report, columns: parsed.headers, row_count: parsed.rows.length,
    duration_seconds: durationSeconds ?? null, active_dtcs: parsed.activeDtcs,
    summary: {
      faultCodes: session.summary?.faultCodes ?? null,
      fuel: calculateFuelMetrics(parsed),
      summaries, headerMapping: parsed.headerMapping, timeColumn: parsed.timeColumn,
      rulesetId: ruleset.id, rulesetMatchedVia: ruleset.matched_via,
      // Preserve the original paid analysis in storage; do not present it as current.
      analysis_outdated: !!session.gemini_analysis,
    },
    ruleset_id: ruleset.id, ruleset_matched_via: ruleset.matched_via,
    report_version: REPORT_VERSION, processing_version: PROCESSING_VERSION,
  };
}
