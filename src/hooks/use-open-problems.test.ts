import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { notifyProblemsChanged, useOpenProblems } from './use-open-problems';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-issues', () => ({ getIssuesForCar: get }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('reports a failed refresh even if the previous check said the car was healthy', async () => {
  get.mockResolvedValueOnce([]);
  const { result } = renderHook(() => useOpenProblems('car'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe(false);
  get.mockRejectedValueOnce(new Error('offline'));
  act(() => notifyProblemsChanged());
  await waitFor(() => expect(result.current.error).toBe(true));
  get.mockResolvedValueOnce([]);
  await act(async () => { await result.current.reload(); });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(result.current.error).toBe(false));
});
