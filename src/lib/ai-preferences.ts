import { supabase } from '@/integrations/supabase/client';
import { getCurrentUser } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/sim/demo/mode';

export type AiProviderMode = 'global' | 'personal';

export interface AiPreferenceStatus {
  mode: AiProviderMode;
  keyConfigured: boolean;
  keyLast4: string | null;
  model: string | null;
  canSaveKey: boolean;
  globalConfigured: boolean;
  globalModel: string;
}

export type AiPreferenceAction = { targetAccountId: string } & (
  | { action: 'status' | 'delete' }
  | { action: 'save'; mode: 'global' }
  | { action: 'save'; mode: 'personal'; model: string; apiKey?: string }
);

export interface AiAccount {
  id: string;
  name: string | null;
  email: string | null;
}

interface AiAccountPage {
  accounts: AiAccount[];
  nextCursor: string | null;
}

type AiAdminAction = AiPreferenceAction | { action: 'accounts'; cursor?: string };

export const isAiModelId = (model: string) => /^[a-z0-9][a-z0-9._:/-]{1,199}$/i.test(model.trim());
export const isAiApiKey = (key: string) => /^[!-~]{16,512}$/.test(key.trim());

const unavailable = () => new Error('ai_preferences_unavailable');

function preferenceStatus(data: unknown): AiPreferenceStatus {
  if (typeof data !== 'object' || data === null) throw unavailable();
  const { mode, keyConfigured, keyLast4, model, canSaveKey, globalConfigured, globalModel } = data as Record<string, unknown>;
  if ((mode !== 'global' && mode !== 'personal') || typeof keyConfigured !== 'boolean'
      || (keyLast4 !== null && (typeof keyLast4 !== 'string' || keyLast4.length !== 4))
      || (model !== null && typeof model !== 'string') || typeof canSaveKey !== 'boolean'
      || typeof globalConfigured !== 'boolean' || typeof globalModel !== 'string') throw unavailable();
  return { mode, keyConfigured, keyLast4: keyConfigured ? keyLast4 : null, model, canSaveKey, globalConfigured, globalModel };
}

function accountPage(data: unknown): AiAccountPage {
  if (typeof data !== 'object' || data === null) throw unavailable();
  const { accounts, nextCursor } = data as Record<string, unknown>;
  if (!Array.isArray(accounts) || (nextCursor !== null && typeof nextCursor !== 'string')) throw unavailable();
  return {
    accounts: (accounts as unknown[]).map((entry) => {
      if (typeof entry !== 'object' || entry === null) throw unavailable();
      const { id, name, email } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || (name !== null && typeof name !== 'string') || (email !== null && typeof email !== 'string')) throw unavailable();
      return { id, name, email };
    }),
    nextCursor,
  };
}

/** Bind the request to the signed-in actor, independently of the selected target. */
async function invokeAiAdmin<T>(accountId: string, input: AiAdminAction, parse: (data: unknown) => T, signal?: AbortSignal): Promise<T> {
  const assertAccount = async () => {
    const { data: { user } } = await getCurrentUser();
    if (signal?.aborted || isDemoMode() || user?.id !== accountId) throw unavailable();
  };
  try {
    await assertAccount();
    if (signal?.aborted || isDemoMode()) throw unavailable();
    const { data, error } = await supabase.functions.invoke('ai-preferences', { body: { ...input, accountId }, signal });
    await assertAccount();
    if (error) throw unavailable();
    return parse(data);
  } catch {
    // Do not propagate a raw fetch, validation, or database error from a credential request.
    throw unavailable();
  }
}

export function requestAiPreference(accountId: string, input: AiPreferenceAction, signal?: AbortSignal): Promise<AiPreferenceStatus> {
  return invokeAiAdmin(accountId, input, preferenceStatus, signal);
}

export function listAiAccounts(accountId: string, cursor?: string, signal?: AbortSignal): Promise<AiAccountPage> {
  return invokeAiAdmin(accountId, { action: 'accounts', ...(cursor ? { cursor } : {}) }, accountPage, signal);
}
