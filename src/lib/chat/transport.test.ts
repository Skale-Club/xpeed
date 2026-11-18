import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { chatViaEdge } from '@/lib/ai-client';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke } } }));

const virtual = { mode: 'virtual', sessionId: 'session-a', conversationId: 'chat-a', messageId: 'message-a' } as const;

beforeEach(async () => {
  invoke.mockReset();
  await i18n.changeLanguage('en');
});

it('keeps the Real payload and sends only references and the question for Virtual', async () => {
  invoke.mockResolvedValue({ data: { reply: 'Answer' }, error: null });
  const history = [{ role: 'model' as const, parts: 'Prior answer' }];
  const context = { vehicle: 'Real car' };
  await expect(chatViaEdge(history, 'My question', context, 'car-a')).resolves.toBe('Answer');
  expect(invoke).toHaveBeenLastCalledWith('chat', {
    body: { history, message: 'My question', context, language: 'en', carProfileId: 'car-a' },
  });
  await expect(chatViaEdge(history, 'My question', context, 'car-a', virtual)).resolves.toBe('Answer');
  expect(invoke).toHaveBeenLastCalledWith('chat', { body: { ...virtual, message: 'My question', language: 'en' } });
});

it.each([
  [404, 'context_not_found'],
  [503, 'development_disabled'],
  [503, 'not_configured'],
  [503, 'unavailable'],
  [429, 'limit_reached'],
] as const)('maps a Virtual %s response to %s', async (status, code) => {
  const context = new Response(JSON.stringify({ code }), { status });
  invoke.mockResolvedValue({ data: null, error: { context } });
  await expect(chatViaEdge([], 'My question', {}, undefined, virtual)).rejects.toMatchObject({ kind: code });
});
