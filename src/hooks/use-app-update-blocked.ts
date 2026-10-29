import { useSyncExternalStore } from 'react';
import { isTripRecording, RECORDING_EVENT } from '@/lib/pwa-update';

function subscribe(listener: () => void) {
  window.addEventListener(RECORDING_EVENT, listener);
  return () => window.removeEventListener(RECORDING_EVENT, listener);
}

export function useAppUpdateBlocked() {
  return useSyncExternalStore(subscribe, isTripRecording, () => false);
}
