import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.read }) }) }) } }));
import { csvChecksum, recordedSessionId, hasRecordedReceipt } from './recorded-session';
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
it('keeps retries stable and separates owners, cars and millisecond starts', async () => {
  const id = await recordedSessionId('u1', 'car', 'trip-1000');
  expect(await recordedSessionId('u1', 'car', 'trip-1000')).toBe(id);
  for (const args of [['u2', 'car', 'trip-1000'], ['u1', 'other', 'trip-1000'], ['u1', 'car', 'trip-1001']]) {
    expect(await recordedSessionId(...args as [string, string, string])).not.toBe(id);
  }
});
it('recognizes only a completed receipt with the exact original checksum', async () => {
  const checksum = await csvChecksum('original');
  const identity = { userId: 'u1', sessionId: 'trip' };
  h.read.mockResolvedValue({ data: { id: 'trip', user_id: 'u1', car_profile_id: 'car', summary: { recording_complete: true, recording_checksum: checksum } }, error: null });
  expect(await hasRecordedReceipt(identity, 'car', checksum)).toBe(true);
  await expect(hasRecordedReceipt(identity, 'car', await csvChecksum('different'))).rejects.toThrow(/preserved/);
  await expect(hasRecordedReceipt({ ...identity, userId: 'u2' }, 'car', checksum)).rejects.toThrow(/preserved/);
});
it('does not treat a failed receipt read as permission to start another upload', async () => {
  h.read.mockResolvedValue({ data: null, error: { message: 'offline' } });
  await expect(hasRecordedReceipt({ userId: 'u1', sessionId: 'trip' }, 'car', 'hash')).rejects.toThrow(/offline/);
});
