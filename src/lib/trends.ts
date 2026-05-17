// Trend analysis utilities — used to enrich the AI chat context with
// "is X getting better or worse?" signals that the rule engine can't see.

import type { Session, SessionSummaryItem } from '@/types/session';

export interface ParameterTrend {
  canonical_key: string;
  label?: string;
  current_avg: number;
  historic_avg: number;
  delta_pct: number;
  trend: 'improving' | 'declining' | 'stable';
  sample_count: number;
}

const HIGHER_IS_BETTER = new Set([
  'fuel_economy', 'average_fuel_consumption', 'mpg_or_fuel_rate',
  'battery_voltage_12v',
]);

const HIGHER_IS_WORSE = new Set([
  'coolant_temp', 'intake_air_temp', 'oil_temp', 'engine_load',
  'transmission_temp', 'catalyst_temp',
  'stft_b1', 'stft_b2', 'ltft_b1', 'ltft_b2',
]);

function getMetric(summaries: SessionSummaryItem[], canonicalKey: string): number | null {
  const item = summaries.find(s => s.canonical_key === canonicalKey);
  return typeof item?.avg === 'number' ? item.avg : null;
}

/**
 * Compute per-parameter trends comparing the most recent N sessions
 * against the prior M sessions.
 */
export function computeTrends(
  sessions: Session[],
  recentCount: number = 5,
  historicCount: number = 20,
): ParameterTrend[] {
  if (sessions.length < 2) return [];

  // Sort sessions newest-first
  const sorted = [...sessions].sort((a, b) => {
    const da = new Date(a.session_start || a.uploaded_at).getTime();
    const db = new Date(b.session_start || b.uploaded_at).getTime();
    return db - da;
  });

  const recent = sorted.slice(0, recentCount);
  const historic = sorted.slice(recentCount, recentCount + historicCount);
  if (historic.length === 0) return [];

  // Collect all canonical keys present in the data
  const keys = new Set<string>();
  for (const s of sorted) {
    for (const item of s.summary?.summaries || []) {
      if (item.canonical_key) keys.add(item.canonical_key);
    }
  }

  const trends: ParameterTrend[] = [];

  for (const key of keys) {
    const recentVals: number[] = recent
      .map(s => getMetric(s.summary?.summaries || [], key))
      .filter((v): v is number => v !== null);
    const historicVals: number[] = historic
      .map(s => getMetric(s.summary?.summaries || [], key))
      .filter((v): v is number => v !== null);

    if (recentVals.length < 2 || historicVals.length < 2) continue;

    const currentAvg = recentVals.reduce((a, b) => a + b, 0) / recentVals.length;
    const historicAvg = historicVals.reduce((a, b) => a + b, 0) / historicVals.length;

    if (Math.abs(historicAvg) < 0.001) continue; // avoid divide-by-zero
    const deltaPct = ((currentAvg - historicAvg) / Math.abs(historicAvg)) * 100;

    // Threshold for trend classification: ±5%
    let trend: ParameterTrend['trend'];
    if (Math.abs(deltaPct) < 5) {
      trend = 'stable';
    } else if (deltaPct > 0) {
      trend = HIGHER_IS_WORSE.has(key) ? 'declining'
            : HIGHER_IS_BETTER.has(key) ? 'improving'
            : 'stable';
    } else {
      trend = HIGHER_IS_WORSE.has(key) ? 'improving'
            : HIGHER_IS_BETTER.has(key) ? 'declining'
            : 'stable';
    }

    const labelItem = sorted[0].summary?.summaries?.find(s => s.canonical_key === key);
    trends.push({
      canonical_key: key,
      label: labelItem?.label ?? undefined,
      current_avg: Math.round(currentAvg * 100) / 100,
      historic_avg: Math.round(historicAvg * 100) / 100,
      delta_pct: Math.round(deltaPct * 10) / 10,
      trend,
      sample_count: recentVals.length + historicVals.length,
    });
  }

  // Sort by largest absolute delta first
  trends.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));
  return trends;
}
