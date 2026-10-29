import { expect, it } from 'vitest';
import { supabase } from './fake-supabase';

it('respects projection, offset and multiple sort keys in the visual harness', async () => {
  const state = (window as unknown as { __harnessDb: Record<string, unknown[]> }).__harnessDb;
  state.review_rows = [
    { id: 'b', day: 1, privateValue: 'hidden' },
    { id: 'c', day: 2, privateValue: 'hidden' },
    { id: 'a', day: 1, privateValue: 'hidden' },
  ];
  const { data, count } = await supabase.from('review_rows').select('id', { count: 'exact' }).order('day').order('id').range(1, 1);
  expect(data).toEqual([{ id: 'b' }]);
  expect(count).toBe(3);
});

it('does not pretend unsupported transactional RPCs succeeded', async () => {
  const result = await supabase.rpc('reprocess_session');
  expect(result.error?.message).toContain('not simulated');
});
