/** Normalize the current and historical report shapes without trusting model output types. */
export function analysisDisplay(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    insights: strings(raw.key_findings ?? raw.insights),
    recommendations: typeof raw.recommended_action === 'string' && raw.recommended_action.trim()
      ? [raw.recommended_action] : strings(raw.recommendations),
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined,
  };
}
