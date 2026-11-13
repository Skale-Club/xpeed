/* eslint-disable react-refresh/only-export-components */
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { fakeV1Fetch, fakeV1State, type FakeV1State } from '@/test/v1-fake-server';
import { vi } from 'vitest';

/** Shows where the router is, so a test can say "it went to this address". */
export function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

/** What the screens of the Virtual side need around them: a query client, a router, settings, and a fake of the racing data API. */
export function renderSim(ui: ReactNode, options: { route?: string; state?: FakeV1State } = {}) {
  const state = options.state ?? fakeV1State();
  vi.stubGlobal('fetch', vi.fn(fakeV1Fetch(state)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.route ?? '/virtual/sessions']}>
        <SettingsProvider>
          {ui}
          <Where />
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, state };
}

/** The address as the router has it now. */
export const whereNow = (element: HTMLElement) => new URL(`http://x${element.textContent}`);
