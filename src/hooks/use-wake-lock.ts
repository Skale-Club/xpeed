import { useEffect } from 'react';

type Sentinel = { release: () => Promise<void> };
type WakeLockApi = { request: (type: 'screen') => Promise<Sentinel> };

/**
 * Keep the screen on while `active` (phone in the car mount), so the browser
 * doesn't suspend the page and drop the Bluetooth link.
 */
export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!wakeLock) return;
    let sentinel: Sentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const s = await wakeLock.request('screen');
        if (cancelled) void s.release();
        else sentinel = s;
      } catch {
        // Denied (e.g. battery saver) — everything still works, the screen may just sleep.
      }
    };
    // The browser drops the lock when the tab is hidden; take it again on return.
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}
