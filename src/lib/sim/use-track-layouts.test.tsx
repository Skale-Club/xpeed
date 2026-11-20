import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { useTrackLayout } from './garage-queries';
import { listTracks } from './track-library';
import { useLayoutFinder } from './use-track-layouts';

let userId = 'ana';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: userId } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

const layout = (variant: string, width = 8) =>
  gzipBytes(packLayout(makeLayout({ points: circle(200, 40), name: 'brands', variant, width })));
const entry = (variant: string, updatedAt = '2026-11-20T10:00:00.000Z') =>
  ({ id: variant.toLowerCase(), game: 'ac', trackName: 'brands', variant, title: 'Brands Hatch', updatedAt });
const response = (tracks: ReturnType<typeof entry>[]) => new Response(JSON.stringify({ tracks }), { status: 200 });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

let idb: FakeIdb;
let client: QueryClient;
const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  userId = 'ana';
  idb = installFakeIndexedDb();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  idb.uninstall();
  vi.unstubAllGlobals();
});

describe('layout lookup', () => {
  it('retries a failed directory read and refreshes a held layout when the account version changes', async () => {
    const gp = entry('GP');
    const indy = entry('Indy');
    let directory = new Response(null, { status: 503 });
    let bytes = await layout('GP');
    const fetcher = vi.fn(async (url: string) => new URL(url).pathname.endsWith('/gp/file') ? new Response(bytes) : directory.clone());
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useLayoutFinder(), { wrapper });
    const find = () => result.current.findLayout('ac', 'brands', 'GP');
    await expect(find()).rejects.toMatchObject({ status: 503 });
    directory = response([indy, gp]);
    expect((await find())?.header.track.variant).toBe('GP');
    await find();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/file'))).toHaveLength(1);
    bytes = await layout('GP', 24);
    directory = response([indy, { ...gp, updatedAt: '2026-11-20T11:00:00.000Z' }]);
    const updated = await find();
    expect(updated?.centerline.left[0]).toBe(24);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/file'))).toHaveLength(2);
  });

  it('ignores a completed old download when the account is switched', async () => {
    const gp = entry('GP');
    const first = deferred<Response>();
    const oldFile = await layout('GP');
    const newFile = await layout('GP', 24);
    const fetcher = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/file')) return response([gp]);
      return url.searchParams.get('account') === 'ana' ? first.promise : new Response(newFile);
    });
    vi.stubGlobal('fetch', fetcher);
    const { result, rerender } = renderHook(() => useLayoutFinder(), { wrapper });
    const previous = result.current.findLayout('ac', 'brands', 'GP').catch((error: unknown) => error);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/file'))).toBe(true));
    userId = 'bea';
    rerender();
    expect((await result.current.findLayout('ac', 'brands', 'GP'))?.centerline.left[0]).toBe(24);
    first.resolve(new Response(oldFile));
    await expect(previous).resolves.toMatchObject({ name: 'AbortError' });
    expect(await listTracks('ana')).toEqual([]);
    expect(await listTracks('bea')).toHaveLength(1);
  });

  it('re-reads a catalog layout with the same ID when its server revision changes', async () => {
    const track = {
      id: 'catalog-id', game: 'ac', name: 'Brands Hatch', sourceName: 'brands', variant: 'GP',
      layoutId: 'gp', layoutUpdatedAt: '2026-11-20T10:00:00.000Z',
    };
    let bytes = await layout('GP');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const { result, rerender } = renderHook(({ updated }) => useTrackLayout({ ...track, layoutUpdatedAt: updated }, true), {
      wrapper, initialProps: { updated: track.layoutUpdatedAt },
    });
    await waitFor(() => expect(result.current.data?.centerline.left[0]).toBe(8));
    bytes = await layout('GP', 24);
    rerender({ updated: '2026-11-20T11:00:00.000Z' });
    await waitFor(() => expect(result.current.data?.centerline.left[0]).toBe(24));
  });

  it('rejects a catalog ID from an old server when its file belongs to a different variant', async () => {
    const bytes = await layout('Indy');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const { result } = renderHook(() => useTrackLayout({ game: 'ac', name: 'brands', layoutId: 'indy' }, true), { wrapper });
    await waitFor(() => expect(result.current.data).toBeNull());
  });
});
