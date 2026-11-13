import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { fakeV1Fetch, fakeV1State, v1Lap, type FakeV1State } from '@/test/v1-fake-server';
import { bytesOf } from './read-lap-file';
import { PAGE_SIZE, V1Error, invalidateAfterDelete, isOutage, isSignedOut, useLaps, useOverview, useSessions, v1Delete, v1Get, v1GetBlob, v1Keys } from './v1-client';

let token: string | null = 'token';
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

let state: FakeV1State;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  token = 'token';
  state = fakeV1State();
  fetchMock = vi.fn(fakeV1Fetch(state));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)![0]));

describe('the error shape', () => {
  it('maps { error, retryable } to a V1Error with status, code and retryable', async () => {
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    const error = await v1Get('/laps').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(V1Error);
    expect(error).toMatchObject({ status: 503, code: 'unavailable', retryable: true });
    expect(isOutage(error)).toBe(true);
    expect(isSignedOut(error)).toBe(false);
  });

  it('keeps a 4xx as not retryable, with the server’s code', async () => {
    const error = await v1Get('/sessions/not-there').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404, code: 'session_not_found', retryable: false });
    expect(isOutage(error)).toBe(false);
  });

  it('tells signed out (401) from a failure', async () => {
    state.failing = { status: 401, error: 'unauthorized', retryable: false };
    expect(isSignedOut(await v1Get('/overview').catch((e: unknown) => e))).toBe(true);
  });

  it('is signed out, without calling the server, when there is no token', async () => {
    token = null;
    const error = await v1Get('/overview').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes an unreachable server a retryable network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await v1Get('/overview').catch((e: unknown) => e)).toMatchObject({ status: 0, code: 'network', retryable: true });
  });

  it('copes with an error body that is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await v1Get('/overview').catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'unavailable', retryable: true });
  });
});

describe('calls', () => {
  it('sends the sign-in token and the filters, and leaves out the ones that are not set', async () => {
    await v1Get('/laps', { game: 'lmu', track: 'abc', car: undefined, valid: false, limit: 25 });
    const url = lastUrl();
    expect(url.pathname).toBe('/api/sim/v1/laps');
    expect(Object.fromEntries(url.searchParams)).toEqual({ game: 'lmu', track: 'abc', valid: 'false', limit: '25' });
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('downloads a lap file as bytes and deletes with DELETE', async () => {
    const lap = v1Lap();
    state.laps = [lap];
    state.files.set(lap.id, new Uint8Array([1, 2, 3]));
    expect(Array.from(await bytesOf(await v1GetBlob(`/laps/${lap.id}/file`)))).toEqual([1, 2, 3]);
    await v1Delete(`/laps/${lap.id}`);
    expect(state.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/laps/${lap.id}` });
    expect(await v1Delete(`/laps/${lap.id}`).catch((e: unknown) => e)).toMatchObject({ code: 'lap_not_found' });
  });
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, Wrap };
}

describe('paging with a cursor', () => {
  it('reads one page, then the next with the cursor the server gave, until there is none', async () => {
    state.laps = Array.from({ length: PAGE_SIZE + 7 }, (_, i) => v1Lap({ lapNumber: i + 1, startedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, i)).toISOString() }));
    const { Wrap } = wrapper();
    const { result } = renderHook(() => useLaps({ game: 'lmu' }), { wrapper: Wrap });

    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE));
    expect(result.current.hasNextPage).toBe(true);
    expect(state.requests[0].params).toMatchObject({ game: 'lmu', limit: String(PAGE_SIZE) });
    expect(state.requests[0].params.cursor).toBeUndefined();

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE + 7));
    expect(state.requests[1].params.cursor).toBeTruthy(); // the opaque cursor of the first page
    expect(result.current.hasNextPage).toBe(false);
    // Newest first, no lap twice.
    expect(new Set(result.current.items.map((lap) => lap.id)).size).toBe(PAGE_SIZE + 7);
    expect(result.current.items[0].lapNumber).toBe(PAGE_SIZE + 7);
  });

  it('sends the filters of the sessions list', async () => {
    const { Wrap } = wrapper();
    renderHook(() => useSessions({ game: 'ac', track: 't1', car: 'c1' }), { wrapper: Wrap });
    await waitFor(() => expect(state.requests).toHaveLength(1));
    expect(state.requests[0]).toMatchObject({ method: 'GET', path: '/sessions', params: { game: 'ac', track: 't1', car: 'c1' } });
  });
});

describe('what a delete refreshes', () => {
  it('reads again everything of the account, and nothing of another account', async () => {
    const { client, Wrap } = wrapper();
    renderHook(() => useOverview(), { wrapper: Wrap });
    await waitFor(() => expect(client.getQueryState(v1Keys.overview('ana'))?.status).toBe('success'));
    client.setQueryData(v1Keys.overview('bob'), { marker: true });
    await invalidateAfterDelete(client, 'ana');
    expect(client.getQueryState(v1Keys.overview('bob'))?.isInvalidated).toBe(false);
    expect(state.requests.filter((request) => request.path === '/overview').length).toBeGreaterThanOrEqual(2);
  });
});
