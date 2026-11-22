import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { getCurrentUser } from '@/lib/auth/session';

const h = vi.hoisted(() => ({
  rpc: vi.fn(), observe: vi.fn(),
  callback: null as null | ((user: { uid: string } | null) => void),
  verify: vi.fn(), google: vi.fn(), signOut: vi.fn(), custom: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('@/lib/auth/google', () => ({
  observeGoogleUser: h.observe, verifyPhoneCode: h.verify, signInWithGoogle: h.google,
  sendPhoneCode: vi.fn(), signOutGoogle: h.signOut, updateDisplayName: vi.fn(), signInWithCustomToken: h.custom,
}));
beforeEach(() => {
  h.rpc.mockReset(); h.observe.mockReset(); h.verify.mockReset(); h.google.mockReset();
  h.observe.mockImplementation((callback: typeof h.callback) => { h.callback = callback; return vi.fn(); });
});
afterEach(cleanup);
const account = { id: 'existing-app-uuid', email: 'a@example.test', user_metadata: { full_name: 'Ana' } };

it('maps the Google UID to the existing application UUID before exposing a signed-in user', async () => {
  h.rpc.mockResolvedValue({ data: account, error: null });
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await act(async () => h.callback?.({ uid: 'different-google-subject' }));
  expect(result.current.user?.id).toBe('existing-app-uuid');
  expect((await getCurrentUser()).data.user?.id).toBe('existing-app-uuid');
  expect(h.rpc).toHaveBeenCalledWith('register_google_user');
});

it('does not restore an old account after sign-out while registration is pending', async () => {
  let resolve!: (value: unknown) => void;
  h.rpc.mockReturnValue(new Promise((done) => { resolve = done; }));
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  act(() => h.callback?.({ uid: 'old-google-user' }));
  act(() => h.callback?.(null));
  await act(async () => resolve({ data: account, error: null }));
  expect(result.current).toMatchObject({ user: null, loading: false });
  expect((await getCurrentUser()).data.user).toBeNull();
});

it('leaves loading with a useful failure state when Google is not configured', async () => {
  h.observe.mockImplementation(() => { throw new Error('Google unavailable'); });
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current).toMatchObject({ user: null, error: 'Google unavailable' });
});

it('fails closed when the database rejects the Google identity', async () => {
  h.rpc.mockResolvedValue({ data: null, error: new Error('Untrusted project') });
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await act(async () => h.callback?.({ uid: 'foreign-uid' }));
  expect(result.current).toMatchObject({ user: null, loading: false, error: 'Untrusted project' });
});

it('waits for mapped account provisioning after phone confirmation', async () => {
  h.verify.mockResolvedValue({ uid: 'phone-google-uid' });
  h.rpc.mockResolvedValue({ data: account, error: null });
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await act(async () => { await result.current.verifyPhoneCode('+15555555555', '123456'); });
  expect(result.current.user?.id).toBe(account.id);
});

describe('inside the Companion window', () => {
  type Listener = (event: { data: unknown }) => void;
  let listeners: Listener[] = [];
  let answer: unknown = null;
  const custom = h.custom;
  beforeEach(() => {
    custom.mockReset();
    listeners = [];
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/virtual?shell=companion');
    (globalThis as { chrome?: unknown }).chrome = { webview: {
      addEventListener: (_: string, l: Listener) => { listeners.push(l); },
      removeEventListener: (_: string, l: Listener) => { listeners = listeners.filter((x) => x !== l); },
      postMessage: () => { queueMicrotask(() => listeners.forEach((l) => l({ data: answer }))); },
    } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'custom-token', uid: 'companion-uid' }), { status: 200 })));
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
  });

  it('signs in as the Companion account instead of showing the sign-in', async () => {
    answer = { type: 'xpeed:session', code: 'a'.repeat(43) };
    custom.mockResolvedValue({ uid: 'companion-uid' });
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    await act(async () => h.callback?.(null));
    await waitFor(() => expect(custom).toHaveBeenCalledWith('custom-token'));
    // Still loading: the sign-in card never flashes; Firebase reports the new user next.
    expect(result.current.loading).toBe(true);
  });

  it('shows the normal sign-in when the Companion has no code', async () => {
    answer = { type: 'xpeed:session', error: 'not connected' };
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    await act(async () => h.callback?.(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(custom).not.toHaveBeenCalled();
  });

  it('leaves a person who signed out here signed out', async () => {
    answer = { type: 'xpeed:session', code: 'a'.repeat(43) };
    window.sessionStorage.setItem('xpeed.companion.signedOut', '1');
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    await act(async () => h.callback?.(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(custom).not.toHaveBeenCalled();
  });

  it('switches to the Companion account when the page is signed in as somebody else', async () => {
    answer = { type: 'xpeed:session', code: 'a'.repeat(43) };
    h.rpc.mockResolvedValue({ data: account, error: null });
    custom.mockResolvedValue({ uid: 'companion-uid' });
    renderHook(useAuth, { wrapper: AuthProvider });
    await act(async () => h.callback?.({ uid: 'someone-else' }));
    await waitFor(() => expect(custom).toHaveBeenCalledWith('custom-token'));
  });

  it('does nothing more when the page already is the Companion account', async () => {
    answer = { type: 'xpeed:session', code: 'a'.repeat(43) };
    h.rpc.mockResolvedValue({ data: account, error: null });
    const { result } = renderHook(useAuth, { wrapper: AuthProvider });
    await act(async () => h.callback?.({ uid: 'companion-uid' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(custom).not.toHaveBeenCalled();
    expect(result.current.user?.id).toBe(account.id);
  });
});
