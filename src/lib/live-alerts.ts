import type { DefaultRule } from './default-rules';

export interface LiveAlert {
  key: string; label: string; value: number; unit: string; severity: 'critical' | 'warning'; at: number;
}

/** Only continuous, fresh samples can trigger an alert. A gap breaks the evidence. */
export function createLiveAlertMonitor(rules: DefaultRule[]) {
  const states = new Map<string, { since: number; last: number; severity: LiveAlert['severity']; sent: boolean }>();
  return {
    reset() { states.clear(); },
    observe(values: Record<string, number | null>, at: number): LiveAlert[] {
      const alerts: LiveAlert[] = [];
      for (const rule of rules) {
        const value = values[rule.canonical_key];
        const outside = (min: number | null, max: number | null) => value != null && Number.isFinite(value) && ((min != null && value < min) || (max != null && value > max));
        const severity = outside(rule.critical_min, rule.critical_max) ? 'critical' : outside(rule.warn_min, rule.warn_max) ? 'warning' : null;
        if (!severity) { states.delete(rule.canonical_key); continue; }
        let state = states.get(rule.canonical_key);
        if (!state || at - state.last > 15_000 || at < state.last || state.severity !== severity) {
          state = { since: at, last: at, severity, sent: false };
          states.set(rule.canonical_key, state);
        }
        state.last = at;
        if (!state.sent && at - state.since >= Math.max(1, rule.min_duration_seconds) * 1000) {
          state.sent = true;
          alerts.push({ key: rule.canonical_key, label: rule.label, value: value!, unit: rule.unit, severity, at });
        }
      }
      return alerts;
    },
  };
}
