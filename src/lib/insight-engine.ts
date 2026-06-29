import { ParsedCSV } from './csv-parser';

export interface FlagEvidence {
  min: number | null;
  max: number | null;
  avg: number | null;
  pct_out_of_range: number;
  longest_streak_s: number;
  first_time: number | null;
  last_time: number | null;
}

export interface SessionFlag {
  severity: 'normal' | 'attention' | 'critical';
  canonical_key: string;
  parameter_key: string;
  message: string;
  evidence: FlagEvidence;
}

export interface ParameterSummary {
  canonical_key: string;
  parameter_key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  avg: number;
  median: number;
  count: number;
}

interface Rule {
  canonical_key: string;
  parameter_key: string;
  label: string;
  normal_min: number | null;
  normal_max: number | null;
  warn_min: number | null;
  warn_max: number | null;
  critical_min: number | null;
  critical_max: number | null;
  min_duration_seconds: number;
  notes: string;
}

function getValues(rows: Record<string, number | string | null>[], key: string): number[] {
  return rows
    .map(r => r[key])
    .filter((v): v is number => typeof v === 'number' && !isNaN(v));
}

// Single-pass min/max. Avoids Math.min(...arr)/Math.max(...arr), which throw
// "RangeError: Maximum call stack size exceeded" when spreading the very large
// arrays produced by long OBD logs (summaries run on the full, pre-downsampled
// CSV). Callers guard against empty input; returns ±Infinity if empty, matching
// the previous Math.min/Math.max behaviour.
function minMax(arr: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of arr) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeParameterSummaries(
  parsed: ParsedCSV,
): ParameterSummary[] {
  const summaries: ParameterSummary[] = [];
  for (const [header, mapping] of Object.entries(parsed.headerMapping)) {
    if (parsed.timeColumn?.key === header) continue;
    const values = getValues(parsed.rows, header);
    if (values.length === 0) continue;

    const canonicalKey = mapping?.canonical_key || header;
    const label = mapping?.label || header;
    const unit = mapping?.unit || '';

    const { min, max } = minMax(values);
    summaries.push({
      canonical_key: canonicalKey,
      parameter_key: header,
      label,
      unit,
      min,
      max,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      median: median(values),
      count: values.length,
    });
  }
  return summaries;
}

export function evaluateRules(
  parsed: ParsedCSV,
  rules: Rule[],
): SessionFlag[] {
  const flags: SessionFlag[] = [];
  const sampleInterval = estimateSampleInterval(parsed);

  for (const rule of rules) {
    // Find matching column
    const matchingHeader = Object.entries(parsed.headerMapping).find(
      ([, m]) => m?.canonical_key === rule.canonical_key
    )?.[0];
    if (!matchingHeader) continue;

    const values = getValues(parsed.rows, matchingHeader);
    if (values.length === 0) continue;

    const { min, max } = minMax(values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;

    // Check critical
    let criticalCount = 0;
    let maxCriticalStreak = 0;
    let currentStreak = 0;
    for (const v of values) {
      const outCritical = (rule.critical_max !== null && v > rule.critical_max) ||
        (rule.critical_min !== null && v < rule.critical_min);
      if (outCritical) {
        criticalCount++;
        currentStreak++;
        maxCriticalStreak = Math.max(maxCriticalStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    const criticalStreakSeconds = maxCriticalStreak * sampleInterval;
    if (criticalCount > 0 && criticalStreakSeconds >= (rule.min_duration_seconds / 2)) {
      flags.push({
        severity: 'critical',
        canonical_key: rule.canonical_key,
        parameter_key: matchingHeader,
        message: extractMessage(rule.notes, 'Critical') || `${rule.label} reached critical levels.`,
        evidence: {
          min, max, avg,
          pct_out_of_range: (criticalCount / values.length) * 100,
          longest_streak_s: criticalStreakSeconds,
          first_time: null, last_time: null,
        },
      });
      continue; // Don't double-flag
    }

    // Check warn
    let warnCount = 0;
    let maxWarnStreak = 0;
    currentStreak = 0;
    for (const v of values) {
      const outWarn = (rule.warn_max !== null && v > rule.warn_max) ||
        (rule.warn_min !== null && v < rule.warn_min);
      if (outWarn) {
        warnCount++;
        currentStreak++;
        maxWarnStreak = Math.max(maxWarnStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    const warnStreakSeconds = maxWarnStreak * sampleInterval;
    if (warnCount > 0 && warnStreakSeconds >= rule.min_duration_seconds) {
      flags.push({
        severity: 'attention',
        canonical_key: rule.canonical_key,
        parameter_key: matchingHeader,
        message: extractMessage(rule.notes, 'Attention') || `${rule.label} exceeded attention thresholds.`,
        evidence: {
          min, max, avg,
          pct_out_of_range: (warnCount / values.length) * 100,
          longest_streak_s: warnStreakSeconds,
          first_time: null, last_time: null,
        },
      });
    }
  }

  return flags;
}

function estimateSampleInterval(parsed: ParsedCSV): number {
  if (!parsed.timeColumn || parsed.rows.length < 2) return 1;
  if (parsed.timeColumn.type === 'seconds') {
    const t0 = parsed.rows[0][parsed.timeColumn.key] as number;
    const t1 = parsed.rows[1][parsed.timeColumn.key] as number;
    if (typeof t0 === 'number' && typeof t1 === 'number') return Math.abs(t1 - t0) || 1;
  }
  return 1;
}

function extractMessage(notes: string, level: string): string | null {
  // Try to extract specific level message
  const lower = level.toLowerCase();
  const parts = notes.split(/(?:critical|attention|warn):/i);
  if (lower === 'critical' && parts.length > 1) {
    const criticalPart = notes.split(/critical:/i)[1];
    if (criticalPart) return criticalPart.trim().split('\n')[0].trim();
  }
  if ((lower === 'attention' || lower === 'warn') && notes) {
    const attPart = notes.split(/attention:/i)[1];
    if (attPart) return attPart.trim().split(/critical:/i)[0].trim();
  }
  return notes.split('.')[0] + '.';
}
