import type { VehicleIssue } from './db-issues';
import type { FaultCodeReadout } from './obd/fault-codes';

export interface VehicleNotification {
  source: string;
  fingerprint: string;
  kind: 'problem' | 'scan';
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
      if (item.kind === 'scan') return item.scan && typeof item.scan.checked === 'boolean' && ['stored', 'pending', 'permanent'].every((key) => Array.isArray(item.scan[key]) && item.scan[key].every((code: unknown) => typeof code === 'string')) && (!item.scan.modules || (Array.isArray(item.scan.modules) && item.scan.modules.every((module: unknown) => typeof module === 'string')));
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
  const next = previous?.fingerprint === incoming.fingerprint
    ? { ...incoming, at: previous.at, read: previous.read }
    : incoming;
  return [next, ...items.filter((item) => item.source !== incoming.source)]
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.at.localeCompare(a.at)).slice(0, MAX_NOTIFICATIONS);
}
export function problemNotification(problem: VehicleIssue): VehicleNotification {
  return {
    source: `problem:${problem.id}`,
    fingerprint: `${problem.status}:${problem.severity}:${problem.recurrence_count}`,
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
