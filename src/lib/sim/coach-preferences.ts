import { readPreference, writePreference } from '@/lib/browser-storage';

const preferenceKey = (userId: string) => `xpeed.virtual.coach.v1:${userId}`;

export function isCoachEnabled(userId: string): boolean {
  return readPreference(preferenceKey(userId)) === '1';
}

export function setCoachEnabled(userId: string, enabled: boolean): void {
  writePreference(preferenceKey(userId), enabled ? '1' : null);
}
