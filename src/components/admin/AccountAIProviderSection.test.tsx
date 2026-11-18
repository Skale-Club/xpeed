import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { enterDemo, leaveDemo } from '@/lib/sim/demo/mode';
import type { AiPreferenceStatus } from '@/lib/ai-preferences';
import { AccountAIProviderSection } from './AccountAIProviderSection';

const mock = vi.hoisted(() => ({ account: 'admin-a', isAdmin: true, invoke: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: mock.account }, loading: false }) }));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => ({ isAdmin: mock.isAdmin, loading: false }) }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: async () => ({ data: { user: { id: mock.account } }, error: null }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: mock.invoke } } }));

const defaults: AiPreferenceStatus = {
  mode: 'global', keyConfigured: false, keyLast4: null, model: null,
  canSaveKey: true, globalConfigured: true, globalModel: 'xpeed/default',
};
const saved: AiPreferenceStatus = { ...defaults, mode: 'personal', keyConfigured: true, keyLast4: '1234', model: 'test/vision' };
const accounts = [
  { id: 'account-a', name: 'Account A', email: 'a@example.test' },
  { id: 'account-b', name: null, email: null },
];
const key = 'fake-personal-key-1234';
const saveButton = () => screen.getByRole('button', { name: 'Save AI settings' });
const password = () => screen.getByLabelText('OpenRouter API key');
const personal = () => screen.getByRole('radio', { name: 'Personal OpenRouter key' });

async function open() {
  fireEvent.click(screen.getByText('AI provider by account'));
  return screen.findByRole('combobox', { name: 'Target account' });
}

async function selectAccount(picker: HTMLElement, id = 'account-a', status = defaults) {
  mock.invoke.mockResolvedValueOnce({ data: status, error: null });
  fireEvent.change(picker, { target: { value: id } });
  return screen.findByRole('radio', { name: 'Xpeed AI' });
}

beforeEach(async () => {
  mock.account = 'admin-a';
  mock.isAdmin = true;
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (_name, { body }: { body: { action: string } }) => ({
    data: body.action === 'accounts' ? { accounts, nextCursor: null } : defaults, error: null,
  }));
  leaveDemo();
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  leaveDemo();
  vi.restoreAllMocks();
});

it('does not mount for a non-admin or load any account data', () => {
  mock.isAdmin = false;
  render(<AccountAIProviderSection />);
  expect(screen.queryByText('AI provider by account')).not.toBeInTheDocument();
  expect(mock.invoke).not.toHaveBeenCalled();
});

it('loads pages on request and waits for an explicit target before reading settings', async () => {
  mock.invoke.mockResolvedValueOnce({ data: { accounts: accounts.slice(0, 1), nextCursor: 'first-page' }, error: null });
  render(<AccountAIProviderSection />);
  expect(mock.invoke).not.toHaveBeenCalled();
  const picker = await open();
  expect(picker).toHaveValue('');
  expect(screen.queryByRole('radio', { name: 'Xpeed AI' })).not.toBeInTheDocument();
  expect(mock.invoke).toHaveBeenCalledTimes(1);
  mock.invoke.mockResolvedValueOnce({ data: { accounts: accounts.slice(1), nextCursor: null }, error: null });
  fireEvent.click(screen.getByRole('button', { name: 'Load more accounts' }));
  expect(await screen.findByRole('option', { name: 'account-b' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Account A · a@example.test' })).toBeInTheDocument();
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { action: 'accounts', accountId: 'admin-a', cursor: 'first-page' },
  }));
  expect(await selectAccount(picker, 'account-b')).toBeChecked();
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { action: 'status', accountId: 'admin-a', targetAccountId: 'account-b' },
  }));
});

it('saves personal billing to the selected account only after an explicit submit', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem');
  render(<AccountAIProviderSection />);
  expect(await selectAccount(await open())).toBeChecked();
  expect(mock.invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(personal());
  expect(password()).toHaveAttribute('type', 'password');
  expect(saveButton()).toBeDisabled();
  fireEvent.change(password(), { target: { value: key } });
  fireEvent.change(screen.getByLabelText('OpenRouter model ID'), { target: { value: 'test/vision' } });
  expect(mock.invoke).toHaveBeenCalledTimes(2);
  mock.invoke.mockResolvedValueOnce({ data: saved, error: null });
  fireEvent.click(saveButton());
  expect(await screen.findByText('AI settings saved.')).toBeVisible();
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { accountId: 'admin-a', targetAccountId: 'account-a', action: 'save', mode: 'personal', model: 'test/vision', apiKey: key },
  }));
  expect(screen.getByText('Saved key ends in 1234.')).toBeVisible();
  expect(password()).toHaveValue('');
  expect(store).not.toHaveBeenCalled();
});

it('switches to global without submitting a draft secret and deletes a saved key only after confirmation', async () => {
  render(<AccountAIProviderSection />);
  const global = await selectAccount(await open(), 'account-a', saved);
  fireEvent.change(password(), { target: { value: key } });
  fireEvent.click(global);
  mock.invoke.mockResolvedValueOnce({ data: { ...saved, mode: 'global' }, error: null });
  fireEvent.click(saveButton());
  expect(await screen.findByText('AI settings saved.')).toBeVisible();
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { accountId: 'admin-a', targetAccountId: 'account-a', action: 'save', mode: 'global' },
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
  const confirmation = await screen.findByRole('alertdialog');
  expect(mock.invoke).toHaveBeenCalledTimes(3);
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Remove key' }));
  expect(await screen.findByText('Key removed. This account now uses Xpeed AI.')).toBeVisible();
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { accountId: 'admin-a', targetAccountId: 'account-a', action: 'delete' },
  }));
});

it('stops credential actions in demo and disables personal saving without encrypted server storage', async () => {
  render(<AccountAIProviderSection />);
  await selectAccount(await open(), 'account-a', { ...defaults, canSaveKey: false });
  fireEvent.click(personal());
  expect(password()).toBeDisabled();
  expect(saveButton()).toBeDisabled();
  expect(screen.getByText(/server needs encrypted key storage/)).toBeVisible();
  await act(async () => enterDemo());
  expect(screen.queryByText('AI provider by account')).not.toBeInTheDocument();
  expect(mock.invoke).toHaveBeenCalledTimes(2);
});

it('drops a pending result and clears the key form when the selected target changes', async () => {
  render(<AccountAIProviderSection />);
  const picker = await open();
  await selectAccount(picker);
  fireEvent.click(personal());
  fireEvent.change(password(), { target: { value: key } });
  let finish!: (value: { data: AiPreferenceStatus; error: null }) => void;
  mock.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(saveButton());
  await waitFor(() => expect(mock.invoke).toHaveBeenCalledTimes(3));
  const { signal } = mock.invoke.mock.calls[2][1];
  fireEvent.change(picker, { target: { value: 'account-b' } });
  expect(signal.aborted).toBe(true);
  expect(screen.queryByLabelText('OpenRouter API key')).not.toBeInTheDocument();
  expect(await screen.findByRole('radio', { name: 'Xpeed AI' })).toBeChecked();
  await act(async () => finish({ data: saved, error: null }));
  expect(screen.queryByText('Saved key ends in 1234.')).not.toBeInTheDocument();
  fireEvent.click(personal());
  expect(password()).toHaveValue('');
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { accountId: 'admin-a', targetAccountId: 'account-b', action: 'status' },
  }));
});

it('aborts a pending target lookup and resets the disclosure when the actor changes', async () => {
  const view = render(<AccountAIProviderSection />);
  const picker = await open();
  let finish!: (value: { data: AiPreferenceStatus; error: null }) => void;
  mock.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  fireEvent.change(picker, { target: { value: 'account-a' } });
  await waitFor(() => expect(mock.invoke).toHaveBeenCalledTimes(2));
  const { signal } = mock.invoke.mock.calls[1][1];
  mock.account = 'admin-b';
  view.rerender(<AccountAIProviderSection />);
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('combobox', { name: 'Target account' })).not.toBeInTheDocument();
  await act(async () => finish({ data: saved, error: null }));
  expect(screen.queryByText('Saved key ends in 1234.')).not.toBeInTheDocument();
  expect(await open()).toHaveValue('');
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { accountId: 'admin-b', action: 'accounts' },
  }));
});
