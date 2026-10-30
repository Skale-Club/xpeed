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
 *     after 30 seconds without interaction, with no recording, draft or editor in use.
 *
 * RECORDING CONTRACT (the OBD code owns this, this module only reads it):
 *   - While a trip is being recorded, the app calls `setTripRecording(true)`;
 *     when it stops (saved or discarded) it calls `setTripRecording(false)`.
 *   - That sets `window.__xpeedRecording` and dispatches a
 *     `xpeed:recording` CustomEvent with `detail: { recording: boolean }`.
 *   - Code that cannot import this module can do the same by hand:
 *       window.__xpeedRecording = true;
 *       window.dispatchEvent(new CustomEvent('xpeed:recording', { detail: { recording: true } }));
 *   - A pending update waits for the flag to turn false and for the idle window.
 */

import { createIdleUpdateGate } from './idle-update';
import { reloadPreservingScreen } from './update-position';

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
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RECORDING_EVENT));
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
let manualReload: (() => Promise<'blocked' | 'reloading'>) | null = null;
/** Explicit screen reload never clears account data, recordings, or preferences. */
export async function reloadAppScreens(): Promise<'blocked' | 'reloading'> {
  if (isTripRecording()) return 'blocked';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw Error('No internet connection');
  if (manualReload) return manualReload();
  if (isTripRecording()) return 'blocked';
  reloadPreservingScreen();
  return 'reloading';
}


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
 * Returns cleanup for the shared listeners and timers.
 */
export function startPwaUpdates(register: RegisterSW): () => void {
  let registration: ServiceWorkerRegistration | undefined;
  let reloadWaiting = false;
  let reloaded = false;
  const idle = createIdleUpdateGate(() => { void tryApply(); tryReload(); }, isTripRecording);
  const tryReload = () => {
    if (!reloadWaiting || reloaded || isTripRecording()) return;
    if (!idle.ready()) { idle.request(); return; }
    reloaded = true;
    reloadPreservingScreen();
  };
  const requestReload = () => { reloadWaiting = true; tryReload(); };

  const tryApply = (manual = false) => {
    if (!updateWaiting || isTripRecording()) return;
    if (!manual && recentlyApplied()) { idle.request(Date.now() + MIN_APPLY_GAP_MS); return; }
    if (!manual && !idle.ready()) { idle.request(); return; }
    updateWaiting = false;
    markApplied();
    // The register helper only reloads when a worker already controlled the page at
    // load; on a first visit it doesn't, and the page would keep running old code
    // against the new cache. Reload ourselves once the new worker takes over.
    navigator.serviceWorker?.addEventListener('controllerchange', requestReload, { once: true });
    // Sends SKIP_WAITING; the new worker then takes control.
    return updateServiceWorker(true).catch((error: unknown) => {
      updateWaiting = true;
      if (manual) throw error;
      console.warn('[pwa] could not apply screen update', error);
    });
  };

  const checkForUpdate = () => {
    if (!registration) return;
    // update() rejects when offline; that is fine, we try again later.
    registration.update().catch(() => { /* offline */ });
    tryApply();
    tryReload();
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

  manualReload = async () => {
    if (isTripRecording()) return 'blocked';
    if (!registration && navigator.serviceWorker?.getRegistration) registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.update();
    const worker = registration?.installing;
    if (worker && !['installed', 'activated', 'redundant'].includes(worker.state)) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { worker.removeEventListener('statechange', changed); reject(Error('Screen update timed out; try again')); }, 15000);
        const changed = () => {
          if (!['installed', 'activated', 'redundant'].includes(worker.state)) return;
          clearTimeout(timer); worker.removeEventListener('statechange', changed);
          if (worker.state === 'redundant') reject(Error('Screen update could not be installed'));
          else resolve();
        };
        worker.addEventListener('statechange', changed);
      });
    }
    if (isTripRecording()) return 'blocked';
    if (reloaded) return 'reloading';
    if (registration?.waiting || updateWaiting) { updateWaiting = true; await tryApply(true); }
    else { reloaded = true; reloadPreservingScreen(); }
    return 'reloading';
  };

  const interval = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  const visible = () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', checkForUpdate);
  const released = () => { void tryApply(); tryReload(); };
  window.addEventListener(RECORDING_EVENT, released);

  return () => {
    clearInterval(interval); idle.dispose();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', checkForUpdate);
    window.removeEventListener(RECORDING_EVENT, released);
    navigator.serviceWorker?.removeEventListener('controllerchange', requestReload);
    manualReload = null;
  };
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
    reloadPreservingScreen();
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
