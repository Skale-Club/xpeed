import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { makeSampleLaps } from '@/lib/sim/sample-laps';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { vi } from 'vitest';
import { SessionsList } from './SessionsList';

let userId = 'ana';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: userId } }) }));

const [mine, best] = makeSampleLaps();
const onOtherTrack: LapFile = {
  ...best,
  header: { ...best.header, track: { name: 'Other Ring', lengthM: best.header.track.lengthM }, startedAt: '2026-02-01T12:00:00.000Z', lap: { ...best.header.lap, number: 2 } },
};
const file = async (lap: LapFile, name: string) => new File([await gzipLap(lap)], name);

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}
function renderSessions() {
  return render(
    <MemoryRouter initialEntries={['/sim/sessions']}>
      <SettingsProvider><SessionsList /><Where /></SettingsProvider>
    </MemoryRouter>,
  );
}
const addFiles = (files: File[]) => fireEvent.change(screen.getByTestId('sessions-files'), { target: { files } });
const sessions = () => screen.findAllByTestId('session');
const decoded = () => new URL(`http://x${screen.getByTestId('where').textContent}`).searchParams;

let idb: FakeIdb;
beforeEach(async () => {
  userId = 'ana';
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  idb.uninstall();
});

describe('with no laps', () => {
  it('says how to add some, and where they are kept', async () => {
    renderSessions();
    expect(await screen.findByTestId('sessions-empty')).toHaveTextContent(/No laps yet/);
    expect(screen.getByRole('button', { name: /Add lap files/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Add a folder/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Remove everything/ })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing is uploaded/)).toBeInTheDocument();
  });

  it('says so when the browser cannot keep laps', async () => {
    idb.uninstall();
    renderSessions();
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot keep laps on the device/);
    expect(screen.getByRole('button', { name: /Add lap files/ })).toBeDisabled();
  });
});

describe('adding laps', () => {
  it('groups them into sessions, newest first, with the best lap of each', async () => {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz'), await file(best, 'best.xlap.gz'), await file(onOtherTrack, 'other.xlap.gz')]);
    const found = await waitFor(async () => {
      const list = await sessions();
      expect(list).toHaveLength(2);
      return list;
    });
    expect(found[0]).toHaveTextContent('Other Ring · Sample Car');
    expect(found[1]).toHaveTextContent('Sample Ring · Sample Car');
    expect(found[1]).toHaveTextContent('Laps: 2 (2 valid)');
    expect(found[1]).toHaveTextContent('Best: 0:41.076');
    expect(screen.getByTestId('import-report')).toHaveTextContent('Added 3, already there 0, other files skipped 0.');
    expect(screen.getByText(/Kept on this device only/)).toBeInTheDocument();
  });

  it('says what it already had and what was not a lap', async () => {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz')]);
    await sessions();
    addFiles([await file(mine, 'mine-again.xlap.gz'), new File(['nope'], 'notes.txt')]);
    await waitFor(() => expect(screen.getByTestId('import-report')).toHaveTextContent('Added 0, already there 1'));
    expect(screen.getByRole('alert')).toHaveTextContent('notes.txt: it is not a lap file');
    expect(await sessions()).toHaveLength(1);
  });

  it('takes a whole folder and skips what is not a lap file', async () => {
    renderSessions();
    fireEvent.change(screen.getByTestId('sessions-folder'), { target: { files: [await file(best, 'b.xlap.gz'), new File(['x'], 'b.xlap.gz.part'), new File(['x'], 'README.txt')] } });
    await sessions();
    expect(screen.getByTestId('import-report')).toHaveTextContent('Added 1, already there 0, other files skipped 2.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('looking at a session', () => {
  async function withSession() {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz'), await file(best, 'best.xlap.gz')]);
    await screen.findByTestId('import-report'); // the laps are added one after another: wait for the last
    return (await sessions())[0];
  }
  const rows = (session: HTMLElement) => within(session).getAllByTestId('session-lap');

  it('lists its laps with the gap to the best lap, and marks the best one', async () => {
    const session = await withSession();
    expect(rows(session)).toHaveLength(2);
    const text = rows(session).map((row) => row.textContent ?? '');
    expect(text.some((row) => row.includes('0:41.390') && /\+0\.31\d s/.test(row))).toBe(true);
    expect(text.some((row) => row.includes('0:41.076') && row.includes('Best lap'))).toBe(true);
  });

  it('opens the compare screen with a lap and the best lap', async () => {
    const session = await withSession();
    const slower = rows(session).find((row) => row.textContent?.includes('0:41.390'))!;
    fireEvent.click(within(slower).getByRole('button', { name: 'Compare with best' }));
    const params = decoded();
    expect(screen.getByTestId('where').textContent?.startsWith('/sim/compare?a=')).toBe(true);
    expect(params.get('a')).toMatch(/^ana\|sample\|Sample Ring\|Sample Car\|.*\|7\|41390\|/);
    expect(params.get('b')).toMatch(/\|5\|41076\|/);
    // The best lap has nothing to be compared with.
    const quickest = rows(session).find((row) => row.textContent?.includes('0:41.076'))!;
    expect(within(quickest).getByRole('button', { name: 'Compare with best' })).toBeDisabled();
  });

  it('compares any two laps picked, the first picked as the lap', async () => {
    const session = await withSession();
    const compare = within(session).getByRole('button', { name: 'Compare the two selected' });
    expect(compare).toBeDisabled();
    const lapOf = (row: HTMLElement) => row.querySelector('input')!;
    const bestRow = rows(session).find((row) => row.textContent?.includes('0:41.076'))!;
    const slowRow = rows(session).find((row) => row.textContent?.includes('0:41.390'))!;
    fireEvent.click(lapOf(bestRow)); // picked first: it becomes the lap
    expect(compare).toBeDisabled();
    fireEvent.click(lapOf(slowRow));
    expect(compare).toBeEnabled();
    fireEvent.click(compare);
    const params = decoded();
    expect(params.get('a')).toMatch(/\|5\|41076\|/);
    expect(params.get('b')).toMatch(/\|7\|41390\|/);
  });

  it('can be hidden and shown again', async () => {
    const session = await withSession();
    fireEvent.click(within(session).getByRole('button', { name: /Hide laps/ }));
    expect(within(session).queryAllByTestId('session-lap')).toHaveLength(0);
    fireEvent.click(within(session).getByRole('button', { name: /Show laps/ }));
    expect(within(session).getAllByTestId('session-lap')).toHaveLength(2);
  });
});

describe('removing laps', () => {
  it('removes a session after asking, and only that one', async () => {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz'), await file(onOtherTrack, 'other.xlap.gz')]);
    const list = await waitFor(async () => {
      const found = await sessions();
      expect(found).toHaveLength(2);
      return found;
    });
    fireEvent.click(within(list[1]).getByRole('button', { name: 'Remove session' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove this session?');
    expect(dialog).toHaveTextContent('1 laps are removed from this device');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getAllByTestId('session')).toHaveLength(1));
    expect(screen.getByTestId('session')).toHaveTextContent('Other Ring');
  });

  it('keeps everything when the question is answered with cancel', async () => {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz')]);
    await sessions();
    fireEvent.click(screen.getByRole('button', { name: /Remove everything/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('session')).toHaveLength(1);
  });

  it('removes everything after asking', async () => {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz'), await file(onOtherTrack, 'other.xlap.gz')]);
    await screen.findByTestId('import-report');
    expect(await sessions()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Remove everything/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByTestId('sessions-empty')).toBeInTheDocument();
  });
});

describe('one account at a time', () => {
  it('shows an account only its own laps', async () => {
    const first = renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz')]);
    await sessions();
    first.unmount();

    userId = 'bob';
    renderSessions();
    expect(await screen.findByTestId('sessions-empty')).toBeInTheDocument();
  });
});
