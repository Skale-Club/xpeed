import { useSyncExternalStore } from 'react';
import { getAppUpdateSnapshot, subscribeAppUpdates } from '@/lib/app-update-monitor';

export function useAppUpdate() {
  return useSyncExternalStore(subscribeAppUpdates, getAppUpdateSnapshot, getAppUpdateSnapshot);
}
