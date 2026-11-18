import { beforeEach, expect, it, vi } from 'vitest';
import { setCurrentUser } from '@/lib/auth/session';
import { createConversation, getConversations } from './db';
import type { ChatScope } from './types';

const run = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', async () => {
  const { QueryBuilder } = await import('@/lib/query-builder');
  return { supabase: { from: (table: string) => new QueryBuilder(table, run) } };
});

const scope = { mode: 'virtual', sessionId: 'session-a', label: 'Monza' } satisfies ChatScope;

beforeEach(() => {
  run.mockReset();
  setCurrentUser(null);
});

it('filters the Real list and narrows the Virtual list to its exact session', async () => {
  run.mockResolvedValue({ data: [], error: null });
  await getConversations();
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
    table: 'chat_conversations',
    filters: [
      { column: 'mode', op: 'eq', value: 'real' },
      { column: 'sim_session_id', op: 'is', value: null },
    ],
  }));
  await getConversations(scope);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
    table: 'chat_conversations',
    filters: [
      { column: 'mode', op: 'eq', value: 'virtual' },
      { column: 'sim_session_id', op: 'eq', value: scope.sessionId },
    ],
  }));
});

it('writes only the context belonging to the requested mode', async () => {
  setCurrentUser({ id: 'driver', user_metadata: {} });
  run.mockImplementation(async ({ values }) => ({ data: { ...values, id: 'conversation-a' }, error: null }));

  await createConversation('Real question', 'real-car');
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
    action: 'insert',
    values: {
      title: 'Real question', car_profile_id: 'real-car', mode: 'real', sim_session_id: null, user_id: 'driver',
    },
  }));

  await createConversation('Virtual question', 'real-car', scope);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
    action: 'insert',
    values: {
      title: 'Virtual question', car_profile_id: null, mode: 'virtual', sim_session_id: scope.sessionId, user_id: 'driver',
    },
  }));
});
