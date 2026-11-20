// The server uses the account's saved OpenRouter preference to select credentials,
// model and billing. Chat only sends the question and its context.

import { supabase } from '@/integrations/supabase/client';
import { getCurrentUser } from '@/lib/auth/session';
import i18n from '@/lib/i18n';

export interface AnalysisResult {
  summary: string;
  key_findings: string[];
  recommended_action: string;
  /** Concerns the AI saw in the readings that no fault code or rule covers; they go to the problem list. */
  warnings?: AiWarning[];
}

export interface AiWarning {
  key: string;
  title: string;
  meaning: string;
  action: string;
  urgency: 'urgent' | 'soon' | 'watch' | 'later';
}

export interface ChatContext {
  [key: string]: unknown;
}

/** Why the AI did not answer, so the app can say something useful. */
const PROVIDER_FAILURES = [
  'credential_storage_unavailable', 'ai_preferences_unavailable', 'personal_key_unavailable',
  'invalid_personal_key', 'personal_credits_exhausted', 'personal_model_unavailable',
  'provider_rate_limited', 'provider_unavailable',
] as const;
export type AiFailure = 'limit_reached' | 'not_configured' | 'context_not_found' | 'development_disabled'
  | 'unavailable' | (typeof PROVIDER_FAILURES)[number];

interface VirtualChatRequest {
  mode: 'virtual';
  /** Omitted for the general Virtual assistant. */
  sessionId?: string;
  conversationId: string;
  messageId: string;
}

export class AiError extends Error {
  constructor(public kind: AiFailure) {
    super(kind);
  }
}

// supabase-js wraps non-2xx replies in a FunctionsHttpError whose `context` is the Response.
async function failureKind(error: unknown, virtual = false): Promise<AiFailure> {
  const response = (error as { context?: Response })?.context;
  if (response && typeof response.status === 'number') {
    let code: unknown;
    try {
      code = (await response.clone().json())?.code;
    } catch {
      // Older handlers may return a response without a structured code.
    }
    const providerFailure = PROVIDER_FAILURES.find((failure) => failure === code);
    if (providerFailure) return providerFailure;
    if (code === 'limit_reached' || (response.status === 429 && code == null)) return 'limit_reached';
    if (virtual && response.status === 404) return 'context_not_found';
    if (code === 'development_disabled') return 'development_disabled';
    if (code === 'not_configured' || (response.status === 503 && code == null && !virtual)) return 'not_configured';
  }
  return 'unavailable';
}

/**
 * Plain-language summary of a saved trip. The edge function reads the trip
 * report and the car's open problems from the database. Returns null when the
 * AI is unavailable; the trip itself is already saved either way.
 */
export async function analyzeSessionById(sessionId: string): Promise<AnalysisResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke('analyze-session', {
      body: { sessionId, language: i18n.resolvedLanguage },
    });
    if (error) {
      console.warn('Trip analysis unavailable:', await failureKind(error));
      return null;
    }
    return (data?.analysis as AnalysisResult) ?? null;
  } catch (err) {
    console.warn('Trip analysis threw:', err);
    return null;
  }
}

/** Server-side chat. Throws AiError saying why when there is no answer. */
export async function chatViaEdge(
  history: { role: 'user' | 'model'; parts: string }[],
  message: string,
  context: ChatContext,
  /** The car the owner is asking about; the server checks it is theirs and builds the context itself. */
  carProfileId?: string | null,
  virtual?: VirtualChatRequest,
): Promise<string> {
  const language = i18n.resolvedLanguage;
  const { data: { user } } = await getCurrentUser();
  if (!user?.id) throw new AiError('unavailable');
  const account = { accountId: user.id };
  const { data, error } = await supabase.functions.invoke('chat', {
    body: virtual
      ? { ...virtual, message, language, ...account }
      : { history, message, context, language, ...account, ...(carProfileId ? { carProfileId } : {}) },
  });
  if (error) throw new AiError(await failureKind(error, !!virtual));
  const reply = data?.reply as string | undefined;
  if (!reply) throw new AiError('unavailable');
  return reply;
}
