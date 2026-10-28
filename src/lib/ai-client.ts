// Client-side wrapper that calls the server-side Edge Functions for AI.
// SINGLE PROVIDER MODEL: one OpenRouter API key per system, configured by an
// admin via /admin, which also picks the model. Users without admin-configured
// AI get a clear "AI unavailable" message instead.

import { supabase } from '@/integrations/supabase/client';
import i18n from '@/lib/i18n';

export interface AnalysisResult {
  summary: string;
  key_findings: string[];
  recommended_action: string;
}

export interface ChatContext {
  [key: string]: unknown;
}

/** Why the AI did not answer, so the app can say something useful. */
export type AiFailure = 'limit_reached' | 'not_configured' | 'unavailable';

export class AiError extends Error {
  constructor(public kind: AiFailure) {
    super(kind);
  }
}

// supabase-js wraps non-2xx replies in a FunctionsHttpError whose `context` is the Response.
async function failureKind(error: unknown): Promise<AiFailure> {
  const response = (error as { context?: Response })?.context;
  if (response && typeof response.status === 'number') {
    if (response.status === 429) return 'limit_reached';
    if (response.status === 503) return 'not_configured';
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
): Promise<string> {
  const { data, error } = await supabase.functions.invoke('chat', {
    body: { history, message, context, language: i18n.resolvedLanguage },
  });
  if (error) throw new AiError(await failureKind(error));
  const reply = data?.reply as string | undefined;
  if (!reply) throw new AiError('unavailable');
  return reply;
}
