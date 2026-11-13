/* eslint-disable react-refresh/only-export-components */
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { fakeV1Fetch, fakeV1State, type FakeV1State } from '@/test/v1-fake-server';
import { vi } from 'vitest';

/** Shows where the router is, so a test can say "it went to this address". */
export function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

/** What the screens of the Virtual side need around them: a query client, a router, settings, and a fake of the racing data API. */
export function renderSim(ui: ReactNode, options: { route?: string; state?: FakeV1State; /** The track layouts the account holds (`GET /api/sim/tracks`); none when left out. */ accountTracks?: AccountTrack[]; /** Wraps the routes the page is shown at (a page that reads `useParams`). */ wrap?: (page: ReactNode) => ReactNode } = {}) {
  const state = options.state ?? fakeV1State();
  const v1 = fakeV1Fetch(state);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input), 'http://localhost').pathname === '/api/sim/tracks') {
      return new Response(JSON.stringify({ tracks: options.accountTracks ?? [] }), { status: 200 });
    }
    return v1(input, init);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.route ?? '/virtual/sessions']}>
        <SettingsProvider>
          {options.wrap ? options.wrap(ui) : ui}
          <Where />
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, state };
}

/** The address as the router has it now. */
export const whereNow = (element: HTMLElement) => new URL(`http://x${element.textContent}`);
