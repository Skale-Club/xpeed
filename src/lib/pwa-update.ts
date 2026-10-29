/**
 * Keeps an always-open Xpeed (a phone mounted in the car, or the Android app
 * that loads the live site) on the latest deployment.
 *
 * Why this exists: the generated registerSW.js only registered the service
 * worker once, and navigations are served from the precached index.html, so an
 * app that was never closed never looked for a new version.
 *
 * What it does:
 *  1. Asks the browser to re-check the service worker script every 30 minutes
 *     and whenever the app comes back to the foreground.
 *  2. When a new worker is waiting, swaps to it (which reloads the page) -
 *     but only when it is safe, i.e. no trip is being recorded.
 *
 * RECORDING CONTRACT (the OBD code owns this, this module only reads it):
 *   - While a trip is being recorded, the app calls `setTripRecording(true)`;
 *     when it stops (saved or discarded) it calls `setTripRecording(false)`.
 *   - That sets `window.__xpeedRecording` and dispatches a
 *     `xpeed:recording` CustomEvent with `detail: { recording: boolean }`.
 *   - Code that cannot import this module can do the same by hand:
 *       window.__xpeedRecording = true;
 *       window.dispatchEvent(new CustomEvent('xpeed:recording', { detail: { recording: true } }));
 *   - A pending update is applied as soon as the flag turns false.
 *   - If nobody ever sets the flag, updates are applied as soon as they are
 *     ready (the previous behaviour for apps without the OBD wiring).
 */

export const RECORDING_EVENT = 'xpeed:recording';
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Do not auto-apply two updates closer together than this (reload-loop guard). */
export const MIN_APPLY_GAP_MS = 60 * 1000;
const LAST_APPLY_KEY = 'xpeed:sw-applied-at';

declare global {
  interface Window {
    __xpeedRecording?: boolean;
  }
}

const persistenceHolds = new Set<symbol>();

export function isTripRecording(): boolean {
  return persistenceHolds.size > 0 || (typeof window !== 'undefined' && window.__xpeedRecording === true);
}

/** Hold updates until the closing trip has a durable local or remote copy. */
export function holdAppUpdates(): () => void {
  const id = Symbol('trip persistence');
  persistenceHolds.add(id);
  return () => {
    if (!persistenceHolds.delete(id)) return;
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RECORDING_EVENT));
  };
}

export function setTripRecording(recording: boolean): void {
  if (typeof window === 'undefined') return;
  window.__xpeedRecording = recording;
  window.dispatchEvent(new CustomEvent(RECORDING_EVENT, { detail: { recording } }));
}

let updateWaiting = false;

/** True when a newer version has been downloaded and is waiting for a safe moment. */
export function hasPendingUpdate(): boolean {
  return updateWaiting;
}

/** Shape of `registerSW` from `virtual:pwa-register` (injected so this file stays testable). */
export type RegisterSW = (options: {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onNeedReload?: () => void;
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => Promise<void>;

function recentlyApplied(): boolean {
  try {
    const at = Number(sessionStorage.getItem(LAST_APPLY_KEY) ?? 0);
    return at > 0 && Date.now() - at < MIN_APPLY_GAP_MS;
  } catch {
    return false;
  }
}

function markApplied(): void {
  try { sessionStorage.setItem(LAST_APPLY_KEY, String(Date.now())); } catch { /* storage unavailable */ }
}

/**
 * Registers the service worker and wires the periodic checks. Call once from main.tsx.
 * Returns a function that tries to apply a waiting update right now (no-op while
 * recording); mostly useful for tests.
 */
export function startPwaUpdates(register: RegisterSW): () => void {
  let registration: ServiceWorkerRegistration | undefined;
  let reloadWaiting = false;
  let reloaded = false;
  const tryReload = () => {
    if (!reloadWaiting || reloaded || isTripRecording()) return;
    reloaded = true;
    window.location.reload();
  };
  const requestReload = () => { reloadWaiting = true; tryReload(); };

  const tryApply = () => {
    if (!updateWaiting || isTripRecording() || recentlyApplied()) return;
    updateWaiting = false;
    markApplied();
    // The register helper only reloads when a worker already controlled the page at
    // load; on a first visit it doesn't, and the page would keep running old code
    // against the new cache. Reload ourselves once the new worker takes over.
    navigator.serviceWorker?.addEventListener('controllerchange', requestReload, { once: true });
    // Sends SKIP_WAITING; the new worker then takes control.
    void updateServiceWorker(true);
  };

  const checkForUpdate = () => {
    if (!registration) return;
    // update() rejects when offline; that is fine, we try again later.
    registration.update().catch(() => { /* offline */ });
    tryApply();
  };

  const updateServiceWorker = register({
    immediate: true,
    onNeedReload: requestReload,
    onNeedRefresh() {
      updateWaiting = true;
      tryApply();
    },
    onRegisteredSW(_swUrl, reg) {
      registration = reg;
    },
    onRegisterError(error) {
      console.warn('[pwa] service worker registration failed', error);
    },
  });

  window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('online', checkForUpdate);
  window.addEventListener(RECORDING_EVENT, () => { tryApply(); tryReload(); });

  return tryApply;
}

const PRELOAD_RELOAD_KEY = 'xpeed:preload-reload-at';
const PRELOAD_RELOAD_GAP_MS = 5 * 60 * 1000;

/**
 * After a deployment the previous build's hashed chunks may be gone and a lazy
 * import fails with `vite:preloadError`. Reloading fetches the new index.html -
 * but if the chunk keeps failing (offline, broken deploy) that would reload
 * forever, so it is allowed at most once per 5 minutes.
 */
export function installPreloadErrorReload(): void {
  let pending = false;
  const tryReload = () => {
    if (!pending || isTripRecording()) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) ?? 0); } catch { /* ignore */ }
    if (last > 0 && Date.now() - last < PRELOAD_RELOAD_GAP_MS) return;
    pending = false;
    try { sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now())); } catch { /* ignore */ }
    window.location.reload();
  };
  window.addEventListener('vite:preloadError', (event) => {
    let last = 0;
    try { last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) ?? 0); } catch { /* ignore */ }
    if (last > 0 && Date.now() - last < PRELOAD_RELOAD_GAP_MS) return; // let the error surface
    event.preventDefault();
    pending = true;
    tryReload();
  });
  window.addEventListener(RECORDING_EVENT, tryReload);
}
