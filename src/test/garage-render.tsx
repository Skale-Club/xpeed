import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { Where } from '@/test/sim-render';
import { fakeV1Fetch, fakeV1State, type FakeV1State } from '@/test/v1-fake-server';

/** A track or a car of `GET /leaderboards/catalog`. */
export interface FakeCatalogItem { id: string; game: string; name: string; lapCount: number; brand?: string | null; class?: string | null }

/**
 * What the track and car screens need around them, like `renderSim`, and a little more: the layout files of the account by id (`GET /api/sim/tracks/<id>/file`)
 * and the leaderboard catalog (`GET /api/sim/v1/leaderboards/catalog`; a list answers with it, `'down'` with a 503, nothing left out answers 404 like a server that predates it).
 */
export function renderGarage(ui: ReactNode, options: {
  route?: string;
  state?: FakeV1State;
  accountTracks?: AccountTrack[];
  files?: Map<string, Uint8Array>;
  catalog?: FakeCatalogItem[] | 'down';
  wrap?: (page: ReactNode) => ReactNode;
} = {}) {
  const state = options.state ?? fakeV1State();
  const v1 = fakeV1Fetch(state);
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/api/sim/tracks') return new Response(JSON.stringify({ tracks: options.accountTracks ?? [] }), { status: 200 });
    const file = /^\/api\/sim\/tracks\/([^/]+)\/file$/.exec(url.pathname);
    if (file) {
      const bytes = options.files?.get(decodeURIComponent(file[1]));
      return bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/api/sim/v1/leaderboards/catalog') {
      if (options.catalog === undefined) return new Response(JSON.stringify({ error: 'not_found', retryable: false }), { status: 404 });
      if (options.catalog === 'down') return new Response(JSON.stringify({ error: 'unavailable', retryable: true }), { status: 503 });
      const wanted = url.searchParams.get('kind') ?? 'track';
      return new Response(JSON.stringify({ kind: wanted, items: options.catalog, nextCursor: null }), { status: 200 });
    }
    return v1(input, init);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.route ?? '/virtual/tracks']}>
        <SettingsProvider>
          {options.wrap ? options.wrap(ui) : ui}
          <Where />
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, state, asked };
}
