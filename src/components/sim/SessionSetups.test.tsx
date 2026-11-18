import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsProvider } from '@/contexts/SettingsContext';
import i18n from '@/lib/i18n';
import { enterDemo, leaveDemo } from '@/lib/sim/demo/mode';
import type { SetupLibrary, SetupVersion } from '@/lib/sim/setup-types';
import SessionSetups from './SessionSetups';

const mock = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), attach: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/sim/setup-client', () => ({
  listSetupVersions: mock.list,
  createSetupVersion: mock.create,
  attachSetupVersion: mock.attach,
  deleteSetupVersion: mock.delete,
  SetupRequestError: class extends Error { constructor(readonly kind: string) { super(kind); } },
}));

const parent: SetupVersion = {
  id: 'parent', label: 'Base setup', notes: 'Dry settings', parentId: null, createdAt: '2026-11-18T00:00:00Z',
  parameters: [{ name: 'Pressure', value: '26', unit: 'psi' }], runs: [],
};
const child: SetupVersion = {
  id: 'child', label: 'Revised setup', notes: 'Enlarged pressures', parentId: parent.id, createdAt: '2026-11-18T01:00:00Z',
  parameters: [{ name: 'Pressure', value: '27', unit: 'psi' }],
  runs: [{
    sessionId: 'session-linked', startedAt: '2026-11-18T02:00:00Z', kind: 'practice',
    weather: null, airTempC: null, trackTempC: null, value: 89500, lapsUsed: 4, cleanLaps: 3, totalLaps: 6, partial: true,
  }],
};
const fromLibrary = (versions = [child, parent], selectedVersionId: string | null = null): SetupLibrary => ({
  versions, selectedVersionId, limit: 20,
});
const button = (name: string) => screen.getByRole('button', { name });
const panel = (userId = 'driver', sessionId = 'source') => (
  <MemoryRouter><SettingsProvider><SessionSetups userId={userId} sessionId={sessionId} /></SettingsProvider></MemoryRouter>
);

beforeEach(async () => {
  vi.resetAllMocks();
  leaveDemo();
  await i18n.changeLanguage('en');
  mock.list.mockResolvedValue(fromLibrary());
  mock.create.mockResolvedValue('new-version');
  mock.attach.mockResolvedValue(undefined);
  mock.delete.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); leaveDemo(); });

async function viewVersion(id: string) {
  const versionPicker = await screen.findByRole('combobox', { name: 'View a library version' });
  fireEvent.change(versionPicker, { target: { value: id } });
}

it('keeps library viewing separate from explicit attachment or detachment', async () => {
  render(panel());
  await viewVersion(child.id);
  expect(screen.getByText('Parent · 26 psi')).toBeVisible();
  expect(screen.getByText('This version · 27 psi')).toBeVisible();
  expect(screen.getByText('Best verified lap · 1:29.500')).toBeVisible();
  expect(screen.getByRole('link', { name: /^Session on/ })).toHaveAttribute('href', '/virtual/sessions/session-linked');
  expect(screen.getByText(/Partial lap data/)).toBeVisible();
  expect(screen.getByText('Weather and temperatures unknown.')).toBeVisible();
  expect(screen.getByText('Session setup is unrecorded.')).toBeVisible();
  expect(mock.attach).not.toHaveBeenCalled();
  const used = screen.getByRole('combobox', { name: 'Version used' });
  expect(used).toHaveValue('');
  expect(button('Save session setup')).toBeDisabled();
  fireEvent.change(used, { target: { value: child.id } });
  expect(mock.attach).not.toHaveBeenCalled();
  mock.list.mockResolvedValueOnce(fromLibrary([child, parent], child.id));
  fireEvent.click(button('Save session setup'));
  expect(await screen.findByText('Setup recorded for this session.')).toBeVisible();
  expect(screen.getByText('Recorded version · Revised setup')).toBeVisible();
  expect(mock.attach).toHaveBeenLastCalledWith('driver', 'source', child.id, expect.any(AbortSignal));

  fireEvent.change(used, { target: { value: '' } });
  expect(mock.attach).toHaveBeenCalledTimes(1);
  fireEvent.click(button('Save session setup'));
  expect(await screen.findByText('Setup association removed.')).toBeVisible();
  expect(mock.attach).toHaveBeenLastCalledWith('driver', 'source', null, expect.any(AbortSignal));
});

it('copies a version into a new draft, preserves original values and never attaches on creation', async () => {
  render(panel());
  await viewVersion(parent.id);
  fireEvent.click(button('Copy as new version'));
  expect(screen.getByText('New version from Base setup')).toBeVisible();
  expect(screen.getByLabelText('Notes (optional)')).toHaveValue('Dry settings');
  expect(screen.getByLabelText('Parameter name')).toHaveValue('Pressure');
  expect(screen.getByLabelText('Unit (optional)')).toHaveValue('psi');
  fireEvent.change(screen.getByLabelText('Version name'), { target: { value: 'Track setup' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '28.5' } });
  fireEvent.click(button('Add parameter'));
  const names = screen.getAllByLabelText('Parameter name');
  fireEvent.change(names[1], { target: { value: 'PRESSURE' } });
  fireEvent.change(screen.getAllByLabelText('Value')[1], { target: { value: '27' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Names must be unique');
  expect(button('Save version')).toBeDisabled();
  fireEvent.click(button('Remove parameter 2'));
  const created: SetupVersion = {
    ...parent, id: 'new-version', label: 'Track setup', parentId: parent.id,
    parameters: [{ name: 'Pressure', value: '28.5', unit: 'psi' }],
  };
  mock.list.mockResolvedValueOnce(fromLibrary([created, child, parent]));
  fireEvent.click(button('Save version'));
  expect(await screen.findByText('Version saved to the library.')).toBeVisible();
  expect(mock.create).toHaveBeenCalledWith('driver', 'source', {
    label: 'Track setup', notes: 'Dry settings', parentId: parent.id,
    parameters: [{ name: 'Pressure', value: '28.5', unit: 'psi' }],
  }, expect.any(AbortSignal));
  expect(mock.attach).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Version used' })).toHaveValue('');
  expect(screen.getByText('Parent · 26 psi')).toBeVisible();
  expect(screen.getByText('This version · 28.5 psi')).toBeVisible();
  await viewVersion(parent.id);
  expect(screen.getByText('26 psi')).toBeVisible();
});

it('confirms deletion and shows surviving copies with refreshed associations', async () => {
  mock.list.mockResolvedValueOnce(fromLibrary([child, parent], parent.id));
  render(panel());
  await viewVersion(parent.id);
  fireEvent.click(button('Delete version'));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent('clears its session associations and parent links');
  expect(mock.delete).not.toHaveBeenCalled();
  mock.list.mockResolvedValueOnce(fromLibrary([{ ...child, parentId: null }]));
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete version' }));
  expect(await screen.findByText('Setup version deleted.')).toBeVisible();
  expect(mock.delete).toHaveBeenCalledWith('driver', parent.id, expect.any(AbortSignal));
  expect(screen.getByText('Session setup is unrecorded.')).toBeVisible();
  await viewVersion(child.id);
  expect(screen.getByText('Parent unset')).toBeVisible();
  expect(screen.queryByText('Changes from parent')).not.toBeInTheDocument();
});

it('creates an independent version and offers refresh if the save succeeds before a failed reload', async () => {
  mock.list.mockResolvedValueOnce(fromLibrary([])).mockRejectedValueOnce(new Error('network'));
  render(panel());
  fireEvent.click(await screen.findByRole('button', { name: 'New setup' }));
  expect(screen.getByText('New independent setup')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Version name'), { target: { value: 'Base setup' } });
  fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'Pressure' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '26' } });
  fireEvent.change(screen.getByLabelText('Unit (optional)'), { target: { value: 'psi' } });
  fireEvent.click(button('Save version'));
  expect(await screen.findByRole('alert')).toHaveTextContent('The change was saved.');
  expect(button('New setup')).toBeDisabled();
  expect(mock.create).toHaveBeenCalledWith('driver', 'source', {
    label: 'Base setup', notes: '', parentId: null, parameters: parent.parameters,
  }, expect.any(AbortSignal));
  mock.list.mockResolvedValueOnce(fromLibrary([{ ...parent, id: 'new-version' }]));
  fireEvent.click(button('Refresh setups'));
  expect(await screen.findByText('26 psi')).toBeVisible();
  expect(mock.create).toHaveBeenCalledTimes(1);
  expect(mock.attach).not.toHaveBeenCalled();
});

it('refreshes the run list without submitting a setup association', async () => {
  mock.list.mockResolvedValueOnce(fromLibrary([{ ...child, runs: [] }, parent]));
  render(panel());
  await viewVersion(child.id);
  expect(screen.getByText('Waiting for a session link for this version.')).toBeVisible();
  fireEvent.click(button('Refresh setups'));
  expect(await screen.findByText('Best verified lap · 1:29.500')).toBeVisible();
  expect(mock.list).toHaveBeenCalledTimes(2);
  expect(mock.attach).not.toHaveBeenCalled();
});

it.each([
  ['account changes', 'other-driver', 'source'],
  ['session changes', 'driver', 'new-session'],
] as const)('discards the result and skips refresh after the %s during a write', async (_case, userId, sessionId) => {
  let finish!: () => void;
  mock.attach.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(panel());
  const used = await screen.findByRole('combobox', { name: 'Version used' });
  fireEvent.change(used, { target: { value: child.id } });
  fireEvent.click(button('Save session setup'));
  await waitFor(() => expect(mock.attach).toHaveBeenCalledTimes(1));
  const signal = mock.attach.mock.calls[0][3] as AbortSignal;
  view.rerender(panel(userId, sessionId));
  expect(signal.aborted).toBe(true);
  await waitFor(() => expect(mock.list).toHaveBeenLastCalledWith(userId, sessionId, expect.any(AbortSignal)));
  await act(async () => finish());
  expect(mock.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Setup recorded for this session.')).not.toBeInTheDocument();
});

it('hides setups after sign-out or in demo and ignores a pending read', async () => {
  let finish!: (value: SetupLibrary) => void;
  mock.list.mockReturnValueOnce(new Promise<SetupLibrary>((resolve) => { finish = resolve; }));
  const view = render(panel(''));
  expect(mock.list).not.toHaveBeenCalled();
  view.rerender(panel());
  await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(1));
  const signal = mock.list.mock.calls[0][2] as AbortSignal;
  await act(async () => enterDemo());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(fromLibrary()));
  expect(screen.queryByRole('region', { name: 'Car setups' })).not.toBeInTheDocument();
});
