import { beforeEach, expect, it, vi } from 'vitest';
import { isAiApiKey, isAiModelId, listAiAccounts, requestAiPreference } from './ai-preferences';

const mock = vi.hoisted(() => ({ invoke: vi.fn(), getUser: vi.fn(), demo: false }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: mock.invoke } } }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mock.getUser }));
vi.mock('@/lib/sim/demo/mode', () => ({ isDemoMode: () => mock.demo }));

const signedInAs = (id: string) => ({ data: { user: { id } }, error: null });
const actorId = 'super-admin-a';
const targetAccountId = 'account-b';
const status = {
  mode: 'global',
  keyConfigured: false,
  keyLast4: null,
  model: null,
  canSaveKey: true,
  globalConfigured: true,
  globalModel: 'test/model',
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.demo = false;
  mock.getUser.mockResolvedValue(signedInAs(actorId));
  mock.invoke.mockResolvedValue({ data: status, error: null });
});

it('binds every action to the actor and target and retains only status fields', async () => {
  mock.invoke.mockResolvedValue({ data: { ...status, ignored: 'extra-server-field' }, error: null });
  for (const action of ['status', 'delete'] as const) {
    expect(await requestAiPreference(actorId, { action, targetAccountId })).toEqual(status);
    expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
      body: { action, accountId: actorId, targetAccountId },
    }));
  }
  const input = { action: 'save', mode: 'personal', targetAccountId, model: 'test/model', apiKey: 'fake-personal-key-1234' } as const;
  expect(await requestAiPreference(actorId, input)).toEqual(status);
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({ body: { ...input, accountId: actorId } }));
});

it('lists eligible account labels and follows the cursor without reading any target settings', async () => {
  const account = { id: targetAccountId, name: 'Example', email: null };
  mock.invoke.mockResolvedValue({ data: { accounts: [{ ...account, ignored: 'private detail' }], nextCursor: 'cursor-1' }, error: null });
  expect(await listAiAccounts(actorId)).toEqual({ accounts: [account], nextCursor: 'cursor-1' });
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({ body: { action: 'accounts', accountId: actorId } }));
  await listAiAccounts(actorId, 'cursor-1');
  expect(mock.invoke).toHaveBeenLastCalledWith('ai-preferences', expect.objectContaining({
    body: { action: 'accounts', accountId: actorId, cursor: 'cursor-1' },
  }));
});

it('blocks demo, a changed account or an aborted request before invoking', async () => {
  const input = { action: 'delete', targetAccountId } as const;
  await expect(requestAiPreference('not-current', input)).rejects.toThrow('ai_preferences_unavailable');
  const controller = new AbortController();
  controller.abort();
  await expect(requestAiPreference(actorId, input, controller.signal)).rejects.toThrow('ai_preferences_unavailable');
  mock.demo = true;
  await expect(requestAiPreference(actorId, input)).rejects.toThrow('ai_preferences_unavailable');
  await expect(listAiAccounts(actorId)).rejects.toThrow('ai_preferences_unavailable');
  expect(mock.invoke).not.toHaveBeenCalled();
});

it('discards a response after an account change and returns safe errors', async () => {
  mock.getUser.mockResolvedValueOnce(signedInAs(actorId)).mockResolvedValueOnce(signedInAs('other-admin'));
  await expect(requestAiPreference(actorId, { action: 'status', targetAccountId })).rejects.toThrow('ai_preferences_unavailable');
  expect(mock.invoke).toHaveBeenCalledTimes(1);
  mock.invoke.mockRejectedValue(new Error('raw transport details'));
  await expect(requestAiPreference(actorId, { action: 'status', targetAccountId })).rejects.toThrow(/^ai_preferences_unavailable$/);
});

it('validates optional key replacement and model input using the endpoint formats', () => {
  expect(isAiModelId(' test/model:variant ')).toBe(true);
  expect(isAiModelId('malformed model')).toBe(false);
  expect(isAiModelId('')).toBe(false);
  expect(isAiApiKey(' fake-personal-key-1234 ')).toBe(true);
  expect(isAiApiKey('fake personal key')).toBe(false);
  expect(isAiApiKey('short')).toBe(false);
});
