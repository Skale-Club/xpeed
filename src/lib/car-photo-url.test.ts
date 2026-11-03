import { expect, it, vi } from 'vitest';
const sign = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ createSignedUrl: sign }) } } }));
vi.mock('@/lib/db', () => ({ updateCarProfile: vi.fn() }));
import { carPhotoUrl } from './car-photo';

it('bypasses an unexpired cached link when recovering a failed image', async () => {
  sign.mockResolvedValueOnce({ data: { signedUrl: 'https://example.test/first' } });
  expect(await carPhotoUrl('owner/car.png')).toBe('https://example.test/first');
  expect(await carPhotoUrl('owner/car.png')).toBe('https://example.test/first');
  expect(sign).toHaveBeenCalledTimes(1);
  sign.mockResolvedValueOnce({ data: { signedUrl: 'https://example.test/renewed' } });
  expect(await carPhotoUrl('owner/car.png', true)).toBe('https://example.test/renewed');
  expect(sign).toHaveBeenCalledTimes(2);
});
