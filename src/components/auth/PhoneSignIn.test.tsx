import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PhoneSignIn } from './PhoneSignIn';

const h = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), cancel: vi.fn(), done: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ sendPhoneCode: h.send, verifyPhoneCode: h.verify }) }));
vi.mock('@/lib/auth/google', () => ({ cancelPhoneChallenge: h.cancel }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (_key: string, fallback: string) => fallback,
  i18n: { resolvedLanguage: 'en' },
}) }));
beforeEach(() => { h.send.mockReset().mockResolvedValue(undefined); h.verify.mockReset(); h.done.mockReset(); h.cancel.mockReset(); });
afterEach(cleanup);
function mount() {
  render(<PhoneSignIn onSignedIn={h.done} />);
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '2015550123' } });
  fireEvent.submit(screen.getByTestId('signin-phone'));
}
it('submits a full OTP once when auto-submit and Enter happen together', async () => {
  let resolve!: () => void;
  h.verify.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
  mount();
  const input = await screen.findByLabelText('6-digit code');
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.submit(screen.getByTestId('signin-code'));
  expect(h.verify).toHaveBeenCalledExactlyOnceWith('+12015550123', '123456');
  await act(async () => resolve());
  expect(h.done).toHaveBeenCalledTimes(1);
});
it('shows Google code-expiration errors and lets the user try again', async () => {
  h.verify.mockRejectedValue({ code: 'auth/code-expired' });
  mount();
  fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
  expect(await screen.findByText('Wrong or expired code. Check the SMS or ask for a new one.')).toBeInTheDocument();
  expect(screen.getByLabelText('6-digit code')).toHaveValue('');
  expect(h.done).not.toHaveBeenCalled();
});
it('prevents duplicate SMS requests while a send is pending', async () => {
  h.send.mockReturnValue(new Promise(() => {}));
  mount();
  fireEvent.submit(screen.getByTestId('signin-phone'));
  await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
});
