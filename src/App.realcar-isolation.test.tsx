import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeV1Fetch, fakeV1State } from '@/test/v1-fake-server';

// The whole app with its real providers (auth, settings, modes, cars, the Bluetooth connection, notifications).
// Only the outside world is faked: Google sign-in and the network.
vi.stubEnv('VITE_DATA_API', 'true');
vi.stubEnv('VITE_ENABLE_VIRTUAL', 'true');

vi.mock('@/lib/auth/google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/google')>()),
  observeGoogleUser: (callback: (user: { uid: string } | null) => void) => { queueMicrotask(() => callback({ uid: 'google-1' })); return () => undefined; },
  getAccessToken: async () => 'token',
}));

type Call = { path: string; body: string };
let calls: Call[] = [];

function stubNetwork(cars: object[] = []) {
  const v1 = fakeV1Fetch(fakeV1State());
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push({ path: url.pathname, body: typeof init?.body === 'string' ? init.body : '' });
    if (url.pathname.startsWith('/api/sim') || url.pathname.startsWith('/api/v1')) return v1(input, init);
    if (url.pathname === '/api/db') {
      const body = String(init?.body ?? '{}');
      if (body.includes('register_google_user')) {
        return new Response(JSON.stringify({ data: { id: 'user-1', email: 'a@example.test', user_metadata: {} }, error: null }), { status: 200 });
      }
      if (body.includes('car_profiles')) return new Response(JSON.stringify({ data: cars, error: null }), { status: 200 });
      return new Response(JSON.stringify({ data: [], error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
}

const REAL_CAR_TABLES = /car_profiles|vehicle_issues|sessions|maintenance_events|fuel|trip/i;
const realCarCalls = () => calls.filter((call) => call.path === '/api/sync-problems' || call.path === '/api/vehicle-care' || (call.path === '/api/db' && REAL_CAR_TABLES.test(call.body)));

async function openApp(route: string, mode: 'real' | 'virtual' | 'both') {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('xpeed.route.real', '/live');
  localStorage.setItem('xpeed.modes.v1:user-1', JSON.stringify(mode === 'both' ? ['real', 'virtual'] : [mode]));
  localStorage.setItem('xpeed.mode', mode === 'both' ? 'real' : mode);
  window.history.pushState({}, '', route);
  vi.resetModules();
  const { default: App } = await import('./App');
  return render(<App />);
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens a Virtual page without asking for anything about the real car', async () => {
  stubNetwork([{ id: 'car-1', name: 'Prius', user_id: 'user-1' }]);
  const view = await openApp('/virtual', 'virtual');
  await waitFor(() => expect(calls.some((call) => call.path.startsWith('/api/sim') || call.path.startsWith('/api/v1'))).toBe(true));
  await new Promise((done) => setTimeout(done, 300));
  expect(realCarCalls()).toEqual([]);
  view.unmount();
}, 20_000);

it('still loads the real car on a Real page', async () => {
  stubNetwork([{ id: 'car-1', name: 'Prius', user_id: 'user-1', make: 'Toyota', model: 'Prius' }]);
  const view = await openApp('/live', 'real');
  await waitFor(() => expect(calls.some((call) => call.path === '/api/db' && /car_profiles/.test(call.body))).toBe(true));
  await waitFor(() => expect(calls.some((call) => call.path === '/api/vehicle-care')).toBe(true));
  view.unmount();
}, 20_000);

it('loads the real car when a Virtual-first person switches to Real, and stops asking when they switch back', async () => {
  stubNetwork([{ id: 'car-1', name: 'Prius', user_id: 'user-1', make: 'Toyota', model: 'Prius' }]);
  const view = await openApp('/virtual', 'both');
  await waitFor(() => expect(screen.getAllByTestId('mode-real').length).toBeGreaterThan(0));
  await new Promise((done) => setTimeout(done, 300));
  expect(realCarCalls()).toEqual([]);
  fireEvent.click(screen.getAllByTestId('mode-real')[0]);
  await waitFor(() => expect(calls.some((call) => call.path === '/api/db' && /car_profiles/.test(call.body))).toBe(true));
  await waitFor(() => expect(calls.some((call) => call.path === '/api/vehicle-care')).toBe(true));
  fireEvent.click(screen.getAllByTestId('mode-virtual')[0]);
  await waitFor(() => expect(window.location.pathname.startsWith('/virtual')).toBe(true));
  await new Promise((done) => setTimeout(done, 100));
  const before = realCarCalls().length;
  await new Promise((done) => setTimeout(done, 400));
  expect(realCarCalls().length).toBe(before);
  view.unmount();
}, 20_000);
