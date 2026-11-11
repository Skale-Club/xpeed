import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { listTracks } from '@/lib/sim/track-library';
import { TracksList } from './TracksList';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const layoutFile = async (name: string, fileName: string, over: Partial<Parameters<typeof makeLayout>[0]> = {}) =>
  new File([await gzipBytes(packLayout(makeLayout({ points: circle(400, 60), width: 8, closed: true, ideal: true, name, ...over })))], fileName);

const renderList = () => render(<SettingsProvider><TracksList /></SettingsProvider>);
const addFiles = (files: File[]) => fireEvent.change(screen.getByTestId('track-input'), { target: { files } });

let idb: FakeIdb;
beforeEach(async () => {
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  idb.uninstall();
});

describe('the tracks screen', () => {
  it('says there are none yet, and how they come', async () => {
    renderList();
    expect(await screen.findByTestId('tracks-empty')).toHaveTextContent(/No track layouts yet/);
  });

  it('keeps layout files, lists them by name with their shape, and says what each one has', async () => {
    renderList();
    addFiles([await layoutFile('Monza', 'monza.xtrk'), await layoutFile('Spa', 'spa.xtrk', { ideal: false })]);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(2));
    expect(screen.getByTestId('tracks-added')).toHaveTextContent('2 track layouts kept.');
    const [monza, spa] = screen.getAllByTestId('track-row');
    expect(monza).toHaveTextContent('Monza');
    expect(monza).toHaveTextContent('Assetto Corsa');
    expect(spa).toHaveTextContent('Spa');
    await waitFor(() => expect(within(monza).getByTestId('track-thumb')).toBeInTheDocument());
    expect(within(spa).getByText('ideal line')).toHaveClass('line-through');
    expect(within(monza).getByText('ideal line')).not.toHaveClass('line-through');
  });

  it('says which file is not a track layout, and keeps the others', async () => {
    renderList();
    addFiles([new File(['nope'], 'notes.txt'), await layoutFile('Monza', 'monza.xtrk')]);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('notes.txt: it is not a track layout file'));
    expect(screen.getAllByTestId('track-row')).toHaveLength(1);
  });

  it('removes one after asking', async () => {
    renderList();
    addFiles([await layoutFile('Monza', 'monza.xtrk')]);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Monza' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByTestId('tracks-empty')).toBeInTheDocument());
    expect(await listTracks('ana')).toEqual([]);
  });
});
