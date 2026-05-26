import type { ParsedCSV } from './csv-parser';
import type { ParameterSummary, SessionFlag } from './insight-engine';
import type { CarProfile } from './db';

export const REPORT_VERSION = 1;

// Composite version string: bump either constant when the pipeline changes
// significantly, then old sessions can be identified and reprocessed.
export const PROCESSING_VERSION = `rules-1.0/report-${REPORT_VERSION}`;

export interface SessionReport {
  version: typeof REPORT_VERSION;
  generated_at: string;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine_type: string | null;
    country: string | null;
    ruleset_id: string | null;
    ruleset_matched_via: string | null;
  };
  session: {
    id: string;
    filename: string;
    row_count: number;
    duration_seconds: number | null;
    session_start: string | null;
    parameter_count: number;
  };
  diagnostics: {
    active_dtcs: string[];
    flag_count: number;
    critical_count: number;
    attention_count: number;
    flags: {
      severity: string;
      canonical_key: string;
      message: string;
      pct_out_of_range: number;
      longest_streak_s: number;
    }[];
  };
  parameters: {
    canonical_key: string;
    label: string;
    unit: string;
    avg: number;
    min: number;
    max: number;
    count: number;
  }[];
}

export interface ReportInput {
  sessionId: string;
  filename: string;
  parsed: ParsedCSV;
  summaries: ParameterSummary[];
  flags: SessionFlag[];
  durationSeconds?: number;
  sessionStart?: string | null;
  car: CarProfile | null;
  rulesetId: string | null;
  rulesetMatchedVia: string | null;
}

export function generateReport(input: ReportInput): SessionReport {
  const {
    sessionId, filename, parsed, summaries, flags,
    durationSeconds, sessionStart, car, rulesetId, rulesetMatchedVia,
  } = input;

  return {
    version: REPORT_VERSION,
    generated_at: new Date().toISOString(),
    vehicle: {
      year: car?.year ?? null,
      make: car?.make ?? null,
      model: car?.model ?? null,
      engine_type: car?.engine_type ?? null,
      country: car?.country ?? null,
      ruleset_id: rulesetId,
      ruleset_matched_via: rulesetMatchedVia,
    },
    session: {
      id: sessionId,
      filename,
      row_count: parsed.rows.length,
      duration_seconds: durationSeconds ?? null,
      session_start: sessionStart ?? null,
      parameter_count: summaries.length,
    },
    diagnostics: {
      active_dtcs: parsed.activeDtcs,
      flag_count: flags.length,
      critical_count: flags.filter((f) => f.severity === 'critical').length,
      attention_count: flags.filter((f) => f.severity === 'attention').length,
      flags: flags.map((f) => ({
        severity: f.severity,
        canonical_key: f.canonical_key,
        message: f.message,
        pct_out_of_range: f.evidence.pct_out_of_range,
        longest_streak_s: f.evidence.longest_streak_s,
      })),
    },
    parameters: summaries.map((s) => ({
      canonical_key: s.canonical_key,
      label: s.label,
      unit: s.unit,
      avg: s.avg,
      min: s.min,
      max: s.max,
      count: s.count,
    })),
  };
}

/**
 * Formats a SessionReport into a compact text block suitable for AI prompts.
 * This is the only text the AI should receive — not the raw CSV.
 */
export function formatReportForAI(report: SessionReport): string {
  const v = report.vehicle;
  const s = report.session;
  const d = report.diagnostics;

  const vehicleStr = [v.year, v.make, v.model].filter(Boolean).join(' ')
    || 'Unknown vehicle';
  const engineStr = v.engine_type ? ` (${v.engine_type})` : '';
  const durationStr = s.duration_seconds
    ? `${Math.round(s.duration_seconds / 60)} min`
    : 'unknown duration';

  const lines: string[] = [
    `Vehicle: ${vehicleStr}${engineStr}`,
    `Session: ${s.filename}, ${s.row_count} rows, ${durationStr}`,
    s.session_start ? `Recorded: ${s.session_start}` : '',
    '',
    '--- DIAGNOSTICS ---',
    d.active_dtcs.length
      ? `Active DTCs: ${d.active_dtcs.join(', ')}`
      : 'Active DTCs: none',
    `Flags: ${d.flag_count} total — ${d.critical_count} critical, ${d.attention_count} attention`,
  ];

  const critical = d.flags.filter((f) => f.severity === 'critical');
  if (critical.length > 0) {
    lines.push('', 'CRITICAL:');
    critical.forEach((f) => {
      lines.push(
        `  - ${f.message} (${f.pct_out_of_range.toFixed(0)}% out of range, ${f.longest_streak_s.toFixed(1)}s streak)`
      );
    });
  }

  const attention = d.flags.filter((f) => f.severity === 'attention');
  if (attention.length > 0) {
    lines.push('', 'ATTENTION:');
    attention.forEach((f) => {
      lines.push(
        `  - ${f.message} (${f.pct_out_of_range.toFixed(0)}% out of range, ${f.longest_streak_s.toFixed(1)}s streak)`
      );
    });
  }

  // Include up to 15 parameters with the most diagnostic value
  // (flagged params first, then by variance/range)
  const flaggedKeys = new Set(d.flags.map((f) => f.canonical_key));
  const sorted = [...report.parameters].sort((a, b) => {
    const aFlagged = flaggedKeys.has(a.canonical_key) ? 1 : 0;
    const bFlagged = flaggedKeys.has(b.canonical_key) ? 1 : 0;
    if (aFlagged !== bFlagged) return bFlagged - aFlagged;
    const aRange = a.max - a.min;
    const bRange = b.max - b.min;
    return bRange - aRange;
  });

  lines.push('', `--- PARAMETERS (${report.parameters.length} total, showing top ${Math.min(15, sorted.length)}) ---`);
  sorted.slice(0, 15).forEach((p) => {
    const unitStr = p.unit ? ` ${p.unit}` : '';
    lines.push(
      `  ${p.label || p.canonical_key}: avg=${p.avg.toFixed(1)}${unitStr}, min=${p.min.toFixed(1)}, max=${p.max.toFixed(1)}`
    );
  });

  return lines.filter((l) => l !== undefined).join('\n').trim();
}
