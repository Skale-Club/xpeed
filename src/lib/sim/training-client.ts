import { supabase } from '@/integrations/supabase/client';
import { getCurrentUser } from '@/lib/auth/session';
import { DEMO_USER_ID, isDemoMode } from './demo/mode';
import {
  TRAINING_METRICS, TRAINING_STATUSES,
  type TrainingGoal, type TrainingGoalDraft, type TrainingGoalList, type TrainingMeasurement, type TrainingStatus,
} from './training-types';

export type TrainingFailure = 'insufficient_laps' | 'goal_limit' | 'invalid_goal' | 'unavailable';

export class TrainingRequestError extends Error {
  constructor(readonly kind: TrainingFailure) {
    super(kind);
  }
}

const unavailable = () => new TrainingRequestError('unavailable');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (typeof value !== 'string') throw unavailable();
  return value;
};
const number = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unavailable();
  return value;
};
const boolean = (value: unknown) => {
  if (typeof value !== 'boolean') throw unavailable();
  return value;
};
const nullableNumber = (value: unknown) => value === null ? null : number(value);
const nullableText = (value: unknown) => value === null ? null : text(value);

function measurement(value: unknown): TrainingMeasurement {
  const row = record(value);
  return {
    sessionId: text(row.sessionId),
    startedAt: text(row.startedAt),
    kind: text(row.kind),
    weather: nullableText(row.weather),
    airTempC: nullableNumber(row.airTempC),
    trackTempC: nullableNumber(row.trackTempC),
    value: nullableNumber(row.value),
    lapsUsed: number(row.lapsUsed),
    cleanLaps: number(row.cleanLaps),
    totalLaps: number(row.totalLaps),
    partial: boolean(row.partial),
  };
}

function goal(value: unknown): TrainingGoal {
  const row = record(value);
  const metric = TRAINING_METRICS.find((metric) => metric === row.metric);
  const status = TRAINING_STATUSES.find((status) => status === row.status);
  if (!metric || !status) throw unavailable();
  return {
    id: text(row.id), title: text(row.title), notes: nullableText(row.notes), metric, target: number(row.target), status,
    createdAt: text(row.createdAt), baselineSessionId: text(row.baselineSessionId), baseline: measurement(row.baseline),
    latest: row.latest === null ? null : measurement(row.latest),
    reached: row.reached === null ? null : boolean(row.reached), delta: nullableNumber(row.delta),
  };
}

function goalList(value: unknown): TrainingGoalList {
  const row = record(value);
  if (!Array.isArray(row.goals)) throw unavailable();
  return { goals: row.goals.map(goal), limit: number(row.limit), truncated: boolean(row.truncated) };
}

function withAbort<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function assertAccount(userId: string, signal?: AbortSignal) {
  if (!userId || userId === DEMO_USER_ID || signal?.aborted || isDemoMode()) throw unavailable();
  const { data: { user } } = await withAbort(getCurrentUser(), signal);
  if (signal?.aborted || isDemoMode() || user?.id !== userId) throw unavailable();
}

type TrainingRpc = 'sim_coach_goals' | 'sim_coach_goal_create' | 'sim_coach_goal_status' | 'sim_coach_goal_delete';

async function request(userId: string, name: TrainingRpc, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  try {
    await assertAccount(userId, signal);
    if (signal?.aborted || isDemoMode()) throw unavailable();
    // Cancel waiting for the response. An RPC already received by the server can finish independently.
    const { data, error } = await withAbort(supabase.rpc(name as never, args as never), signal);
    await assertAccount(userId, signal);
    if (error) {
      for (const kind of ['insufficient_laps', 'goal_limit', 'invalid_goal'] as const) {
        if (error.message === kind || error.code === kind) throw new TrainingRequestError(kind);
      }
      throw unavailable();
    }
    return data;
  } catch (error) {
    if (error instanceof TrainingRequestError) throw error;
    throw unavailable();
  }
}

export async function listTrainingGoals(userId: string, sessionId: string, signal?: AbortSignal): Promise<TrainingGoalList> {
  return goalList(await request(userId, 'sim_coach_goals', { p_session_id: sessionId }, signal));
}

export async function createTrainingGoal(userId: string, sessionId: string, draft: TrainingGoalDraft, signal?: AbortSignal): Promise<string> {
  const result = await request(userId, 'sim_coach_goal_create', {
    p_session_id: sessionId, p_title: draft.title.trim(), p_metric: draft.metric,
    p_target: draft.target, p_notes: draft.notes.trim(),
  }, signal);
  if (typeof result !== 'string' || !result) throw unavailable();
  return result;
}

export async function setTrainingGoalStatus(userId: string, goalId: string, status: TrainingStatus, signal?: AbortSignal): Promise<void> {
  if (await request(userId, 'sim_coach_goal_status', { p_id: goalId, p_status: status }, signal) !== true) throw unavailable();
}

export async function deleteTrainingGoal(userId: string, goalId: string, signal?: AbortSignal): Promise<void> {
  if (await request(userId, 'sim_coach_goal_delete', { p_id: goalId }, signal) !== true) throw unavailable();
}
