import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/types/session';

const h = vi.hoisted(() => ({ download: vi.fn(), rpc: vi.fn(), maybeSingle: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  storage: { from: () => ({ download: h.download }) },
  rpc: h.rpc,
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.maybeSingle }) }) }),
  auth: { getUser: async () => ({ data: { user: null } }) },
} }));
vi.mock('./db', () => ({ getCarById: async () => ({ engine_type: 'petrol' }) }));
vi.mock('./issue-reconciler', () => ({ reconcileIssues: vi.fn() }));
import { reprocessStoredSession } from './reprocess-session';

const session = { id: 'trip', car_profile_id: 'car', source_file_path: 'user/original.csv', source_filename: 'Trip', session_start: '2026-10-28T00:00:00Z', gemini_analysis: { summary: 'Earlier paid analysis' } } as unknown as Session;
beforeEach(() => {
  vi.clearAllMocks();
  h.rpc.mockResolvedValue({ error: null });
  h.maybeSingle.mockResolvedValue({ data: null, error: null });
});

it('rechecks the original, preserves identity and publishes all derived readings together', async () => {
  const csv = 'Time (s),Coolant (F)\n' + Array.from({ length: 5000 }, (_, t) => `${t},248`).join('\n');
  h.download.mockResolvedValue({ data: { text: async () => csv }, error: null });
  expect(await reprocessStoredSession(session)).toBe(1);
  expect(h.rpc).toHaveBeenCalledTimes(1);
  const [name, args] = h.rpc.mock.calls[0];
  expect(name).toBe('reprocess_session');
  expect(args.p_session_id).toBe('trip');
  expect(args.p_payload.row_count).toBe(5000);
  expect(args.p_payload.rows).toHaveLength(2000);
  expect(args.p_payload.flags[0]).toMatchObject({ severity: 'critical', evidence: { max: 120, longest_streak_s: 4999 } });
  expect(args.p_payload.report.diagnostics.critical_count).toBe(1);
  expect(args.p_payload.summary.analysis_outdated).toBe(true);
});

it('leaves the stored trip alone if the original is unavailable', async () => {
  h.download.mockResolvedValue({ data: null, error: { message: 'offline' } });
  await expect(reprocessStoredSession(session)).rejects.toThrow(/original CSV/);
  expect(h.rpc).not.toHaveBeenCalled();
});

it('reports an unavailable transaction instead of falling back to partial writes', async () => {
  h.download.mockResolvedValue({ data: { text: async () => 'Time,Coolant\n0,120\n20,120' }, error: null });
  h.rpc.mockResolvedValue({ error: { message: 'function not deployed' } });
  await expect(reprocessStoredSession(session)).rejects.toThrow(/function not deployed/);
  expect(h.rpc).toHaveBeenCalledTimes(1);
});
