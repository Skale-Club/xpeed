import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageRefreshProvider, usePageRefresh } from './PageRefreshContext';
const mock = vi.hoisted(() => ({ cars: vi.fn(async () => undefined), mount: vi.fn(), unmount: vi.fn(), recorderUnmount: vi.fn() }));
vi.mock('./CarsContext', () => ({ useCarsContext: () => ({ refresh: mock.cars }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function Page() {
  useEffect(() => { mock.mount(); return mock.unmount; }, []);
  return <p>Page data</p>;
}
function Screen() {
  const { revision, refresh } = usePageRefresh();
  return <><button onClick={() => void refresh()}>Refresh</button><Page key={revision} /></>;
}
function Recorder() {
  useEffect(() => () => { mock.recorderUnmount(); }, []);
  return <PageRefreshProvider><Screen /></PageRefreshProvider>;
}
it('reloads page data and cached queries while keeping the recording provider mounted', async () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><Recorder /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(mock.mount).toHaveBeenCalledTimes(2));
  expect(mock.cars).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(mock.unmount).toHaveBeenCalledTimes(1);
  expect(mock.recorderUnmount).not.toHaveBeenCalled();
});
