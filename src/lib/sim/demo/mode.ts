// The example mode of the Virtual area: a calm way to look at the pages with made-up laps before Xpeed Companion has sent any.
// It lives entirely on this device. This file is the only part of the example that is in the main bundle (a few lines: the switch and
// its hooks); the made-up account itself (src/lib/sim/demo/index.ts) is loaded on demand, the first time something is read in the example.
import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { toast } from '@/hooks/use-toast';

/** Where the switch is kept: sessionStorage, so the example ends with the tab. */
export const DEMO_STORAGE_KEY = 'xpeed.virtual.example';
/** The "account" the example's data is cached under (query keys, the device's lap cache): never a real one. */
export const DEMO_USER_ID = 'example';
/** Writes that come within this many ms of a note already shown add no second note. */
export const REFUSAL_GAP_MS = 2000;

let active: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether the example is on. Read from the tab's storage once; when the storage cannot be used the switch still works, it is just not kept. */
export function isDemoMode(): boolean {
  if (active === null) {
    try {
      active = sessionStorage.getItem(DEMO_STORAGE_KEY) === '1';
    } catch {
      active = false;
    }
  }
  return active;
}

function set(next: boolean): void {
  active = next;
  try {
    if (next) sessionStorage.setItem(DEMO_STORAGE_KEY, '1');
    else sessionStorage.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // No storage (private window, blocked): the example lasts as long as this page does.
  }
  listeners.forEach((listener) => listener());
}

export const enterDemo = (): void => set(true);
export const leaveDemo = (): void => set(false);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Re-renders when the example is switched on or off. */
export const useDemoMode = (): boolean => useSyncExternalStore(subscribe, isDemoMode, () => false);

/** The switch for the buttons: leaving also forgets everything read in the example (and the real account is read again at once). */
export function useExample() {
  const client = useQueryClient();
  const demo = useDemoMode();
  const enter = useCallback(() => {
    enterDemo();
    client.removeQueries({ queryKey: ['sim-v1'] });
  }, [client]);
  const leave = useCallback(() => {
    leaveDemo();
    client.removeQueries({ queryKey: ['sim-v1'] });
    client.removeQueries({ queryKey: ['sim-lap-file'] });
    client.removeQueries({ queryKey: ['sim-track-layout'] });
    client.removeQueries({ queryKey: ['sim-account-layouts'] });
  }, [client]);
  return { demo, enter, leave };
}

let lastRefusal = 0;

/** What every write says in the example: nothing is changed, saved or sent. One note for a burst (deleting a session is one call per lap). */
export function refuseInDemo(): void {
  if (Date.now() - lastRefusal < REFUSAL_GAP_MS) return;
  lastRefusal = Date.now();
  toast({
    title: i18n.t('demo.unavailable', 'Not available in the example'),
    description: i18n.t('demo.unavailableBody', 'Nothing is saved or sent while you look at the example.'),
  });
}
