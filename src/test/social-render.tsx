import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { Where } from '@/test/sim-render';
import { fakeSocialFetch, fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';

/**
 * What the social screens need around them: a query client, a router, settings, and a fake of the whole racing data API (the read side
 * and the social side, and the public share endpoint). The fetch is a spy, so a test can look at every call and its headers.
 */
export function renderSocial(ui: ReactNode, options: { route?: string; state?: FakeSocialState; client?: QueryClient } = {}) {
  const state = options.state ?? fakeSocialState();
  const fetchSpy = vi.fn(fakeSocialFetch(state));
  vi.stubGlobal('fetch', fetchSpy);
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.route ?? '/virtual']}>
        <SettingsProvider>
          {ui}
          <Where />
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, state, fetchSpy };
}

/** The calls the fake server answered, for one method and a path prefix. */
export const callsTo = (state: FakeSocialState, method: string, path: string) =>
  state.requests.filter((request) => request.method === method && request.path === path);
