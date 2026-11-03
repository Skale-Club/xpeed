import { expect, it, vi } from 'vitest';
import { readAllPages } from './db-pages';

it('reads beyond the response-row cap without dropping the last page', async () => {
  const rows = Array.from({ length: 1207 }, (_, i) => ({ id: String(i) }));
  const page = vi.fn(async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }));
  expect(await readAllPages(page, 'Load failed')).toEqual(rows);
  expect(page).toHaveBeenCalledTimes(3);
  expect(page).toHaveBeenNthCalledWith(2, 500, 999);
});

it('rejects a later failed page instead of returning an incomplete healthy-looking list', async () => {
  const page = vi.fn().mockResolvedValueOnce({ data: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })), error: null })
    .mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
  await expect(readAllPages(page, 'Load failed')).rejects.toThrow('Load failed: offline');
});

it('fails safely when the endpoint ignores pagination', async () => {
  const page = vi.fn(async () => ({ data: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })), error: null }));
  await expect(readAllPages(page, 'Load failed')).rejects.toThrow('pagination did not advance');
  expect(page).toHaveBeenCalledTimes(2);
});
