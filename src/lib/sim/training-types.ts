export const TRAINING_METRICS = ['best_lap_ms', 'consistency_ms', 'valid_lap_pct'] as const;
export type TrainingMetric = typeof TRAINING_METRICS[number];

export const TRAINING_STATUSES = ['active', 'completed', 'archived'] as const;
export type TrainingStatus = typeof TRAINING_STATUSES[number];

export interface TrainingMeasurement {
  sessionId: string;
  startedAt: string;
  kind: string;
  weather: string | null;
  airTempC: number | null;
  trackTempC: number | null;
  value: number | null;
  lapsUsed: number;
  cleanLaps: number;
  totalLaps: number;
  partial: boolean;
}

export interface TrainingGoal {
  id: string;
  title: string;
  notes: string | null;
  metric: TrainingMetric;
  target: number;
  status: TrainingStatus;
  createdAt: string;
  baselineSessionId: string;
  baseline: TrainingMeasurement;
  latest: TrainingMeasurement | null;
  reached: boolean | null;
  delta: number | null;
}

export interface TrainingGoalList {
  goals: TrainingGoal[];
  limit: number;
  truncated: boolean;
}

export interface TrainingGoalDraft {
  title: string;
  notes: string;
  metric: TrainingMetric;
  target: number;
}

/** UI durations are seconds, while the persisted time metrics use integral milliseconds. */
export function parseTrainingTarget(metric: TrainingMetric, value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(trimmed)) return null;
  const number = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(number)) return null;
  if (metric === 'valid_lap_pct') return number <= 100 ? number : null;
  const ms = Math.round(number * 1000);
  if (ms > 3_600_000 || (metric === 'best_lap_ms' && ms < 1_000)) return null;
  return ms;
}
