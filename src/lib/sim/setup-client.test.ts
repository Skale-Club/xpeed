import { beforeEach, expect, it, vi } from 'vitest';
import { attachSetupVersion, createSetupVersion, deleteSetupVersion, listSetupVersions } from './setup-client';
import { compareSetupParameters, normalizeSetupDraft, type SetupLibrary, type SetupVersionDraft } from './setup-types';

const mock = vi.hoisted(() => ({ userId: 'driver', demo: false, rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => ({ data: { user: mock.userId ? { id: mock.userId } : null }, error: null }),
}));
vi.mock('./demo/mode', () => ({ DEMO_USER_ID: 'example', isDemoMode: () => mock.demo }));

const draft: SetupVersionDraft = {
  label: ' Evening run ', notes: ' Test setup\nAfter rain ', parentId: 'parent-a',
  parameters: [{ name: ' Tyre pressure ', value: ' 28.5 ', unit: ' psi ' }],
};
const library: SetupLibrary = {
  selectedVersionId: null, limit: 20,
  versions: [{
    id: 'version-a', label: 'Evening run', notes: 'Test setup\nAfter rain', parentId: 'parent-a',
    parameters: [{ name: 'Tyre pressure', value: '28.5', unit: 'psi' }],
    createdAt: '2026-11-18T00:00:00Z',
    runs: [{
      sessionId: 'later', startedAt: '2026-11-18T01:00:00Z', kind: 'practice',
      weather: null, airTempC: null, trackTempC: null, value: 89500,
      lapsUsed: 4, cleanLaps: 3, totalLaps: 7, partial: true,
    }],
  }],
};

beforeEach(() => {
  mock.userId = 'driver';
  mock.demo = false;
  mock.rpc.mockReset();
});

it('preserves user-entered units and returns case-insensitive additions, removals and changes', () => {
  const oldRows = [
    { name: 'Pressure', value: '28', unit: 'psi' },
    { name: 'Wing', value: '5', unit: '' },
    { name: 'Damping', value: 'Soft', unit: 'clicks' },
    { name: 'Toe', value: '0.2', unit: '°' },
  ];
  const newRows = [
    { name: 'PRESSURE', value: '28', unit: 'kPa' },
    { name: 'WING', value: '7', unit: '' },
    { name: 'toe', value: '0.2', unit: '°' },
    { name: 'Camber', value: '-1.5', unit: '°' },
  ];
  const snapshot = structuredClone([oldRows, newRows]);
  expect(compareSetupParameters(oldRows, newRows)).toEqual([
    { name: 'PRESSURE', before: '28 psi', after: '28 kPa' },
    { name: 'WING', before: '5', after: '7' },
    { name: 'Damping', before: 'Soft clicks', after: null },
    { name: 'Camber', before: null, after: '-1.5 °' },
  ]);
  expect([oldRows, newRows]).toEqual(snapshot);
});

it('validates row sizes, control characters and case-insensitive duplicate names', () => {
  expect(normalizeSetupDraft(draft)).toEqual({
    label: 'Evening run', notes: 'Test setup\nAfter rain', parentId: 'parent-a',
    parameters: [{ name: 'Tyre pressure', value: '28.5', unit: 'psi' }],
  });
  const invalidRows = [
    [],
    Array.from({ length: 33 }, (_, i) => ({ name: String(i), value: '1', unit: '' })),
    [{ name: 'Tyre pressure', value: '2', unit: '' }, { name: ' TYRE PRESSURE ', value: '3', unit: '' }],
    [{ name: '', value: '3', unit: '' }],
    [{ name: 'Name', value: ' ', unit: '' }],
    [{ name: 'Name', value: '7\n8', unit: '' }],
    [{ name: 'Name', value: '1', unit: 'x'.repeat(21) }],
  ];
  for (const parameters of invalidRows) expect(normalizeSetupDraft({ ...draft, parameters })).toBeNull();
});

it('uses owner-scoped RPCs, with creation separate from association and null to detach', async () => {
  mock.rpc.mockResolvedValueOnce({
    data: { ...library, versions: [{ ...library.versions[0], internal: 'ignored by client' }] }, error: null,
  });
  expect(await listSetupVersions('driver', 'source')).toEqual(library);
  mock.rpc.mockResolvedValueOnce({ data: 'new-version', error: null });
  expect(await createSetupVersion('driver', 'source', draft)).toBe('new-version');
  expect(mock.rpc).toHaveBeenCalledTimes(2);
  mock.rpc.mockResolvedValue({ data: true, error: null });
  await attachSetupVersion('driver', 'source', 'new-version');
  await attachSetupVersion('driver', 'source', null);
  await deleteSetupVersion('driver', 'new-version');
  expect(mock.rpc.mock.calls).toEqual([
    ['sim_setup_versions', { p_session_id: 'source' }],
    ['sim_setup_create', {
      p_session_id: 'source', p_label: 'Evening run', p_notes: 'Test setup\nAfter rain', p_parent_id: 'parent-a',
      p_parameters: [{ name: 'Tyre pressure', value: '28.5', unit: 'psi' }],
    }],
    ['sim_setup_attach', { p_session_id: 'source', p_version_id: 'new-version' }],
    ['sim_setup_attach', { p_session_id: 'source', p_version_id: null }],
    ['sim_setup_delete', { p_id: 'new-version' }],
  ]);
});

it('maps known failures and withholds malformed data or raw errors', async () => {
  await expect(createSetupVersion('driver', 'source', { ...draft, label: '' })).rejects.toMatchObject({ kind: 'invalid_setup' });
  expect(mock.rpc).not.toHaveBeenCalled();
  mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'setup_limit', details: 'internal detail' } });
  await expect(createSetupVersion('driver', 'source', draft)).rejects.toMatchObject({ kind: 'setup_limit', message: 'setup_limit' });
  mock.rpc.mockResolvedValueOnce({ data: { ...library, versions: [{ ...library.versions[0], runs: [null] }] }, error: null });
  await expect(listSetupVersions('driver', 'source')).rejects.toMatchObject({ kind: 'unavailable' });
  mock.rpc.mockRejectedValueOnce(new Error('internal row information'));
  await expect(deleteSetupVersion('driver', 'version-a')).rejects.toMatchObject({ kind: 'unavailable', message: 'unavailable' });
});

it('blocks signed-out, demo, mismatched and already-aborted operations before an RPC', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(listSetupVersions('driver', 'source', controller.signal)).rejects.toMatchObject({ kind: 'unavailable' });
  await expect(listSetupVersions('other', 'source')).rejects.toMatchObject({ kind: 'unavailable' });
  mock.userId = '';
  await expect(deleteSetupVersion('driver', 'version-a')).rejects.toMatchObject({ kind: 'unavailable' });
  mock.userId = 'driver';
  mock.demo = true;
  await expect(attachSetupVersion('driver', 'source', null)).rejects.toMatchObject({ kind: 'unavailable' });
  expect(mock.rpc).not.toHaveBeenCalled();
});

it('discards late RPC results after an abort and an account change', async () => {
  let finish!: (result: { data: SetupLibrary; error: null }) => void;
  mock.rpc.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const aborted = listSetupVersions('driver', 'source', controller.signal);
  await vi.waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ kind: 'unavailable' });
  finish({ data: library, error: null });

  mock.rpc.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const changing = listSetupVersions('driver', 'source');
  await vi.waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(2));
  mock.userId = 'new-driver';
  finish({ data: library, error: null });
  await expect(changing).rejects.toMatchObject({ kind: 'unavailable' });
});
