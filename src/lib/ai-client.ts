// Client-side wrapper that calls the server-side Edge Functions for Gemini AI.
// SINGLE PROVIDER MODEL: one Gemini API key per system, configured by an
// admin via /admin. There is no per-user fallback path — users without
// admin-configured AI see a clear "AI unavailable" message instead.

import { supabase } from '@/integrations/supabase/client';

export interface AnalysisResult {
  summary: string;
  key_findings: string[];
  recommended_action: string;
}

export interface ChatContext {
  [key: string]: unknown;
}

/**
 * Server-side analysis via Edge Function.
 */
export async function analyzeSessionViaEdge(
  sessionSummary: string,
  model: string = 'gemini-2.5-flash',
): Promise<AnalysisResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke('analyze-session', {
      body: { sessionSummary, model },
    });
    if (error) {
      console.warn('Edge analyze-session failed:', error.message);
      return null;
    }
    return (data?.analysis as AnalysisResult) ?? null;
  } catch (err) {
    console.warn('Edge analyze-session threw:', err);
    return null;
  }
}

/**
 * Server-side chat via Edge Function.
 */
export async function chatViaEdge(
  history: { role: 'user' | 'model'; parts: string }[],
  message: string,
  context: ChatContext,
  model: string = 'gemini-2.5-flash',
): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('chat', {
      body: { history, message, context, model },
    });
    if (error) {
      console.warn('Edge chat failed:', error.message);
      return null;
    }
    return (data?.reply as string) ?? null;
  } catch (err) {
    console.warn('Edge chat threw:', err);
    return null;
  }
}
