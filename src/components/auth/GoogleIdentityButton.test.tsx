import { render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GoogleIdentityButton } from './GoogleIdentityButton';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ signInWithGoogleIdToken: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('resizes the Google iframe with its container and stops observing after closing login', async () => {
  let width = 390;
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() { /* test drives the resize explicitly */ }
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const renderButton = vi.fn();
  vi.stubGlobal('google', { accounts: { id: { initialize: vi.fn(), renderButton } } });
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'xpeed.apps.googleusercontent.com');
  const view = render(<GoogleIdentityButton onSignedIn={vi.fn()} />);
  await waitFor(() => expect(renderButton).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ width: 390 })));
  width = 280;
  resize();
  expect(renderButton).toHaveBeenLastCalledWith(expect.any(HTMLElement), expect.objectContaining({ width: 280 }));
  view.unmount();
  const calls = renderButton.mock.calls.length;
  resize();
  expect(renderButton).toHaveBeenCalledTimes(calls);
  expect(disconnect).toHaveBeenCalledOnce();
});
