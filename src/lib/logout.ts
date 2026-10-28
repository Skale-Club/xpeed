import { supabase } from '@/integrations/supabase/client';
import { adminStatusCache } from '@/hooks/use-admin-status';
import type { QueryClient } from '@tanstack/react-query';

const USER_DATA_KEYS = ['selected_car_id'];

export type BeforeLogoutCleanup = () => void | Promise<void>;

const cleanups = new Set<BeforeLogoutCleanup>();

/** Most a single cleanup may take before logout moves on (e.g. a hung upload). */
export const CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Registers work that must finish while the user is still signed in, before
 * their session and local data are wiped. Typical use: upload unsaved trip
 * copies kept on the device (IndexedDB 'xpeed-obd') and only then delete them.
 *
 * Contract:
 *  - Cleanups run in parallel, before supabase.auth.signOut(), each limited to
 *    CLEANUP_TIMEOUT_MS. A cleanup that throws or times out does NOT block the
 *    logout, so it must itself keep anything it could not safely handle
 *    (never delete data it failed to upload).
 *  - Returns an unregister function (call it from effect cleanups / tests).
 */
export function beforeLogout(cleanup: BeforeLogoutCleanup): () => void {
  cleanups.add(cleanup);
  return () => { cleanups.delete(cleanup); };
}

async function runBeforeLogoutCleanups() {
  await Promise.allSettled(
    [...cleanups].map((fn) =>
      Promise.race([
        Promise.resolve().then(fn),
        new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
      ]),
    ),
  );
}

/** Removes the runtime caches (REST copies, share target, ...) but keeps the app shell precache. */
async function clearRuntimeCaches() {
  if (!('caches' in globalThis)) return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => !name.startsWith('workbox-precache') && !name.startsWith('sw-precache'))
        .map((name) => caches.delete(name)),
    );
  } catch { /* ignore */ }
}

export async function logout(queryClient: QueryClient) {
  await runBeforeLogoutCleanups();

  try { await supabase.auth.signOut(); } catch { /* ignore */ }

  Object.keys(localStorage)
    .filter(k => k.startsWith('sb-'))
    .forEach(k => localStorage.removeItem(k));
  USER_DATA_KEYS.forEach(k => localStorage.removeItem(k));
  sessionStorage.clear();

  adminStatusCache.clear();
  queryClient.clear();

  await clearRuntimeCaches();

  window.location.href = '/login';
}
