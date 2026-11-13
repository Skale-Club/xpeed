import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CarBrandLogo } from './CarBrandLogo';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('falls back on image failure and recovers for a new make or checksum', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['car-brands'], [
    { key: 'toyota', name: 'Toyota', aliases: [], logo: { type: 'image/png', sha256: '1'.repeat(64), bytes: 8, path: 'toyota.png' } },
    { key: 'honda', name: 'Honda', aliases: [], logo: { type: 'image/png', sha256: '2'.repeat(64), bytes: 8, path: 'honda.png' } },
  ]);
  const view = render(<QueryClientProvider client={client}><CarBrandLogo make="Toyota" /></QueryClientProvider>);
  const image = document.querySelector('img')!;
  expect(image).toHaveAttribute('src', expect.stringContaining(`/api/car-brands/toyota/logo?v=${'1'.repeat(64)}`));
  fireEvent.error(image);
  expect(view.container.querySelector('img')).toBeNull();

  view.rerender(<QueryClientProvider client={client}><CarBrandLogo make="Honda" /></QueryClientProvider>);
  expect(view.container.querySelector('img')).toHaveAttribute('src', expect.stringContaining(`/api/car-brands/honda/logo?v=${'2'.repeat(64)}`));

  act(() => client.setQueryData(['car-brands'], [
    { key: 'toyota', name: 'Toyota', aliases: [], logo: { type: 'image/png', sha256: '3'.repeat(64), bytes: 8, path: 'toyota.png' } },
    { key: 'honda', name: 'Honda', aliases: [], logo: { type: 'image/png', sha256: '3'.repeat(64), bytes: 8, path: 'honda.png' } },
  ]));
  view.rerender(<QueryClientProvider client={client}><CarBrandLogo make="Honda" /></QueryClientProvider>);
  expect(view.container.querySelector('img')).toHaveAttribute('src', expect.stringContaining(`/api/car-brands/honda/logo?v=${'3'.repeat(64)}`));

  view.rerender(<QueryClientProvider client={client}><CarBrandLogo make={null} /></QueryClientProvider>);
  expect(view.container.querySelector('img')).toBeNull();
});
