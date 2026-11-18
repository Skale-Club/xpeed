import { supabase } from '@/integrations/supabase/client';
import { getCurrentUser } from '@/lib/auth/session';
import { DEMO_USER_ID, isDemoMode } from './demo/mode';
import { MAX_SETUP_PARAMETERS, normalizeSetupDraft, type SetupLibrary, type SetupVersion, type SetupVersionDraft } from './setup-types';
import type { TrainingMeasurement } from './training-types';

const SETUP_FAILURES = ['invalid_setup', 'setup_limit', 'session_not_found'] as const;
export type SetupFailure = typeof SETUP_FAILURES[number] | 'unavailable';

export class SetupRequestError extends Error {
  constructor(readonly kind: SetupFailure) {
    super(kind);
  }
}

const unavailable = () => new SetupRequestError('unavailable');

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unavailable();
  return value;
}

const nullableText = (value: unknown) => value === null ? null : text(value);
const nullableNumber = (value: unknown) => value === null ? null : finite(value);

function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw unavailable();
  return value;
}

function measurement(value: unknown): TrainingMeasurement {
  const row = record(value);
  if (typeof row.partial !== 'boolean') throw unavailable();
  return {
    sessionId: text(row.sessionId), startedAt: text(row.startedAt), kind: text(row.kind),
    weather: nullableText(row.weather), airTempC: nullableNumber(row.airTempC), trackTempC: nullableNumber(row.trackTempC),
    value: nullableNumber(row.value), lapsUsed: finite(row.lapsUsed), cleanLaps: finite(row.cleanLaps), totalLaps: finite(row.totalLaps),
    partial: row.partial,
  };
}

function version(value: unknown): SetupVersion {
  const row = record(value);
  const parameters = array(row.parameters, MAX_SETUP_PARAMETERS).map((entry) => {
    const parameter = record(entry);
    return { name: text(parameter.name), value: text(parameter.value), unit: text(parameter.unit) };
  });
  return {
    id: text(row.id), label: text(row.label), notes: text(row.notes),
    parameters, parentId: nullableText(row.parentId), createdAt: text(row.createdAt),
    runs: array(row.runs, 3).map(measurement),
  };
}

function library(value: unknown): SetupLibrary {
  const row = record(value);
  return { versions: array(row.versions, 20).map(version), selectedVersionId: nullableText(row.selectedVersionId), limit: finite(row.limit) };
}

function waitForResult<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
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
  const { data: { user } } = await waitForResult(getCurrentUser(), signal);
  if (signal?.aborted || isDemoMode() || user?.id !== userId) throw unavailable();
}

type SetupRpc = 'sim_setup_versions' | 'sim_setup_create' | 'sim_setup_attach' | 'sim_setup_delete';

async function request(userId: string, name: SetupRpc, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  try {
    await assertAccount(userId, signal);
    if (signal?.aborted || isDemoMode()) throw unavailable();
    const { data, error } = await waitForResult(supabase.rpc(name as never, args as never), signal);
    await assertAccount(userId, signal);
    if (error) {
      const kind = SETUP_FAILURES.find((failure) => error.message === failure || error.code === failure);
      throw kind ? new SetupRequestError(kind) : unavailable();
    }
    return data;
  } catch (error) {
    if (error instanceof SetupRequestError) throw error;
    throw unavailable();
  }
}

export async function listSetupVersions(userId: string, sessionId: string, signal?: AbortSignal): Promise<SetupLibrary> {
  return library(await request(userId, 'sim_setup_versions', { p_session_id: sessionId }, signal));
}

export async function createSetupVersion(userId: string, sessionId: string, draft: SetupVersionDraft, signal?: AbortSignal): Promise<string> {
  const normalized = normalizeSetupDraft(draft);
  if (!normalized) throw new SetupRequestError('invalid_setup');
  const id = await request(userId, 'sim_setup_create', {
    p_session_id: sessionId, p_label: normalized.label, p_notes: normalized.notes,
    p_parameters: normalized.parameters, p_parent_id: normalized.parentId,
  }, signal);
  if (typeof id !== 'string' || !id) throw unavailable();
  return id;
}

export async function attachSetupVersion(userId: string, sessionId: string, versionId: string | null, signal?: AbortSignal): Promise<void> {
  const result = await request(userId, 'sim_setup_attach', { p_session_id: sessionId, p_version_id: versionId }, signal);
  if (result !== true) throw unavailable();
}

export async function deleteSetupVersion(userId: string, versionId: string, signal?: AbortSignal): Promise<void> {
  if (await request(userId, 'sim_setup_delete', { p_id: versionId }, signal) !== true) throw unavailable();
}
