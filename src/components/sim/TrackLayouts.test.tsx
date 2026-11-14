import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { listTracks } from '@/lib/sim/track-library';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { TrackLayouts } from './TrackLayouts';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

/** The layouts Xpeed Companion sent to the account: the list, and the files by id. */
interface Account {
  tracks: AccountTrack[];
  files: Map<string, Uint8Array>;
  deleted: string[];
}
async function account(...specs: Array<{ id: string; name: string; ideal?: boolean }>): Promise<Account> {
  const out: Account = { tracks: [], files: new Map(), deleted: [] };
  for (const spec of specs) {
    const layout = makeLayout({ points: circle(400, 60), width: 8, closed: true, ideal: spec.ideal ?? true, name: spec.name });
    out.files.set(spec.id, await gzipBytes(packLayout(layout)));
    out.tracks.push({ id: spec.id, game: layout.header.game, trackName: spec.name, variant: null, title: null, lengthM: null, size: 1000, updatedAt: '2026-11-10T12:00:00.000Z' });
  }
  return out;
}
function serve(data: Account) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/sim/tracks') return new Response(JSON.stringify({ tracks: data.tracks }), { status: 200 });
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    if (init?.method === 'DELETE') {
      data.deleted.push(id);
      return new Response(null, { status: 204 });
    }
    const file = data.files.get(id);
    return file ? new Response(file as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  });
}

const renderList = () => render(<MemoryRouter><SettingsProvider><TrackLayouts /></SettingsProvider></MemoryRouter>);

let idb: FakeIdb;
beforeEach(async () => {
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  vi.unstubAllGlobals();
});

describe('the tracks screen', () => {
  it('says there are none yet, and that Xpeed Companion sends them', async () => {
    serve(await account());
    renderList();
    const empty = await screen.findByTestId('tracks-empty');
    expect(empty).toHaveTextContent(/No track maps yet/);
    expect(within(empty).getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
  });

  it('lists the layouts the account has, by name with their shape, and says what each one has', async () => {
    serve(await account({ id: 't1', name: 'Monza' }, { id: 't2', name: 'Spa', ideal: false }));
    renderList();
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(2));
    // How many maps came from the account is bookkeeping: nothing about it is said.
    expect(screen.queryByTestId('tracks-from-account')).not.toBeInTheDocument();
    const [monza, spa] = screen.getAllByTestId('track-row');
    expect(monza).toHaveTextContent('Monza');
    expect(spa).toHaveTextContent('Spa');
    await waitFor(() => expect(within(monza).getByTestId('track-thumb')).toBeInTheDocument());
    expect(within(spa).getByText('ideal line')).toHaveClass('line-through');
    expect(within(monza).getByText('ideal line')).not.toHaveClass('line-through');
  });

  it('removes one after asking, from the device and from the account', async () => {
    const data = await account({ id: 't1', name: 'Monza' });
    serve(data);
    renderList();
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Monza' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByTestId('tracks-empty')).toBeInTheDocument());
    expect(await listTracks('ana')).toEqual([]);
    expect(data.deleted).toEqual(['t1']);
  });

  it('has no way to add a layout by hand: no file input and no drop zone', async () => {
    serve(await account({ id: 't1', name: 'Monza' }));
    const { container } = renderList();
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(1));
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/drop|Add track layout files/i)).not.toBeInTheDocument();
  });
});
