vi.mock('@/lib/auth/session', () => ({ getCurrentUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) }));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uploadSessionPhoto } from './db-extras';
import { uploadCarPhoto } from './car-photo';

const h = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn(), insert: vi.fn(), update: vi.fn(), from: vi.fn() }));
vi.mock('./db', () => ({ updateCarProfile: h.update }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
  storage: { from: () => ({ upload: h.upload, remove: h.remove }) },
  from: h.from,
} }));

beforeEach(() => {
  h.upload.mockReset().mockResolvedValue({ error: null });
  h.remove.mockReset().mockResolvedValue({ error: null });
  h.update.mockReset(); h.insert.mockReset();
  h.from.mockReturnValue({ insert: () => ({ select: () => ({ single: h.insert }) }) });
});
afterEach(() => vi.restoreAllMocks());

it('removes a newly uploaded session photo if metadata cannot be saved', async () => {
  const error = new Error('metadata failed');
  h.insert.mockResolvedValue({ error });
  await expect(uploadSessionPhoto(new File(['img'], 'image.png', { type: 'image/png' }), 'trip')).rejects.toBe(error);
  expect(h.remove).toHaveBeenCalledWith([h.upload.mock.calls[0][0]]);
});

it('keeps the previous car photo if updating its profile fails', async () => {
  const error = new Error('car update failed');
  h.update.mockRejectedValue(error);
  await expect(uploadCarPhoto('car', new File(['img'], 'image.png', { type: 'image/png' }), 'previous.png')).rejects.toBe(error);
  expect(h.remove).toHaveBeenCalledWith([h.upload.mock.calls[0][0]]);
  expect(h.remove).not.toHaveBeenCalledWith(['previous.png']);
});

it('rejects unsupported car photos before uploading', async () => {
  await expect(uploadCarPhoto('car', new File(['text'], 'image.svg', { type: 'image/svg+xml' }))).rejects.toThrow('not-image');
  expect(h.upload).not.toHaveBeenCalled();
});
