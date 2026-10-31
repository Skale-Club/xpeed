import type { LiveAlert } from './live-alerts';
import type { FuelComparison } from './fuel-ledger';
import type { VehicleIssue } from './db-issues';
import type { FaultCodeReadout } from './obd/fault-codes';
import type { OilReminder } from './vehicle-care';

export interface VehicleNotification {
  source: string;
  fingerprint: string;
  live?: LiveAlert;
  kind: 'live' | 'problem' | 'scan' | 'fuel' | 'maintenance';
  oil?: OilReminder;
  fuel?: FuelComparison;
  severity: 'critical' | 'warning' | 'info' | 'success';
  at: string;
  read: boolean;
  problem?: VehicleIssue;
  scan?: FaultCodeReadout;
}
const MAX_NOTIFICATIONS = 100;
export const notificationScope = (userId: string, carId: string) => `xpeed.notifications.${encodeURIComponent(userId)}.${encodeURIComponent(carId)}`;
export function loadVehicleNotifications(scope: string): VehicleNotification[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(scope) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => {
      if (!item || typeof item.source !== 'string' || typeof item.fingerprint !== 'string' || !['critical', 'warning', 'info', 'success'].includes(item.severity) || typeof item.at !== 'string' || typeof item.read !== 'boolean') return false;
      if (item.kind === 'live') return item.live && typeof item.live.key === 'string' && typeof item.live.label === 'string' && typeof item.live.unit === 'string' && Number.isFinite(item.live.value);
      if (item.kind === 'scan') return item.scan && typeof item.scan.checked === 'boolean' && ['stored', 'pending', 'permanent'].every((key) => Array.isArray(item.scan[key]) && item.scan[key].every((code: unknown) => typeof code === 'string')) && (!item.scan.modules || (Array.isArray(item.scan.modules) && item.scan.modules.every((module: unknown) => typeof module === 'string')));
      if (item.kind === 'fuel') return item.fuel && Number.isFinite(item.fuel.deltaPct) && item.fuel.deltaPct >= 10 && typeof item.fuel.period === 'string' && typeof item.fuel.bucket === 'string';
      if (item.kind === 'maintenance') return item.oil && ['due', 'soon'].includes(item.oil.status)
        && (item.oil.dueKm === null || (typeof item.oil.dueKm === 'number' && Number.isFinite(item.oil.dueKm) && item.oil.dueKm >= 0))
        && (item.oil.odometerKm === null || (typeof item.oil.odometerKm === 'number' && Number.isFinite(item.oil.odometerKm) && item.oil.odometerKm >= 0))
        && (item.oil.dueDate === null || (typeof item.oil.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.oil.dueDate)));
      if (item.kind === 'problem') return item.problem && typeof item.problem.id === 'string' && typeof item.problem.canonical_key === 'string' && typeof item.problem.title === 'string' && ['critical', 'serious', 'warning', 'easy_fix'].includes(item.problem.severity);
      return false;
    }).slice(0, MAX_NOTIFICATIONS) : [];
  } catch { return []; }
}
export function saveVehicleNotifications(scope: string, items: VehicleNotification[]) {
  try { localStorage.setItem(scope, JSON.stringify(items.slice(0, MAX_NOTIFICATIONS))); } catch { /* Unread state still works in memory. */ }
}
/** Repeat observations update evidence without turning a read item unread again. */
export function mergeVehicleNotification(items: VehicleNotification[], incoming: VehicleNotification): VehicleNotification[] {
  const previous = items.find((item) => item.source === incoming.source);
  const unchangedProblem = previous?.kind === 'problem' && incoming.kind === 'problem'
    && previous.problem?.status === incoming.problem?.status && previous.problem?.severity === incoming.problem?.severity;
  const next = previous && (previous.fingerprint === incoming.fingerprint || unchangedProblem)
    ? { ...incoming, at: previous.at, read: previous.read }
    : incoming;
  return [next, ...items.filter((item) => item.source !== incoming.source)]
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.at.localeCompare(a.at)).slice(0, MAX_NOTIFICATIONS);
}
export function problemNotification(problem: VehicleIssue): VehicleNotification {
  return {
    source: `problem:${problem.id}`,
    fingerprint: `${problem.status}:${problem.severity}`,
    kind: 'problem', severity: problem.severity === 'critical' ? 'critical' : 'warning',
    at: problem.last_seen_at, read: false, problem,
  };
}
export function scanNotification(scan: FaultCodeReadout, at: string): VehicleNotification {
  const complete = scan.complete ?? (scan.checked && !!scan.modules?.length);
  const fingerprint = JSON.stringify([scan.checked, complete, [...scan.stored].sort(), [...scan.pending].sort(), [...scan.permanent].sort(), [...(scan.modules ?? [])].sort()]);
  const empty = !scan.stored.length && !scan.pending.length && !scan.permanent.length;
  return { source: 'scan', fingerprint, kind: 'scan', severity: !complete ? 'warning' : empty ? 'success' : 'warning', at, read: false, scan };
}
export function oilNotification(oil: OilReminder, planAt: string | null): VehicleNotification {
  return { source: 'oil-change', fingerprint: `${planAt}:${oil.dueKm}:${oil.dueDate}:${oil.status}`, kind: 'maintenance',
    severity: oil.status === 'due' ? 'warning' : 'info', at: new Date().toISOString(), read: false, oil };
}
