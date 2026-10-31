import { checkApkUpdate, type ApkUpdate } from './app-update';
import { isNativeApp } from './obd/native-ble';

export const APK_CHECK_INTERVAL_MS = 30 * 60_000;
const IGNORED_KEY = 'xpeed:apk-ignored-build';
function readIgnored(): number | null {
  try { const value = Number(localStorage.getItem(IGNORED_KEY)); return value > 0 ? value : null; }
  catch { return null; }
}
let snapshot: { update: ApkUpdate | null; checked: boolean; ignoredBuild: number | null } = {
  update: null, checked: false, ignoredBuild: readIgnored(),
};
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let inFlight: Promise<void> | null = null;
const emit = () => listeners.forEach(listener => listener());
const check = (force = false) => {
  if (inFlight || document.visibilityState === 'hidden') return;
  inFlight = checkApkUpdate(force).then(update => {
    snapshot = { ...snapshot, update, checked: true };
    emit();
  }).catch(() => { snapshot = { ...snapshot, checked: true }; emit(); })
    .finally(() => { inFlight = null; });
};
/** One native check shared by the global notice and Settings, with no manual controls. */
export function subscribeAppUpdates(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop && isNativeApp()) {
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    const online = () => check(true);
    const timer = window.setInterval(check, APK_CHECK_INTERVAL_MS);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    stop = () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
    check();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = null; }
  };
}
export const getAppUpdateSnapshot = () => snapshot;
export function ignoreAppUpdate(): void {
  const build = snapshot.update?.required;
  if (!build) return;
  snapshot = { ...snapshot, ignoredBuild: build };
  try { localStorage.setItem(IGNORED_KEY, String(build)); } catch { /* memory fallback */ }
  emit();
}
