import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { makeSampleLaps } from '@/lib/sim/sample-laps';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { vi } from 'vitest';
import { openLap, type AccountLap } from '@/lib/sim/account-laps';
import { listLaps } from '@/lib/sim/library';
import { SessionsList } from './SessionsList';
vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));

let token: string | null = null;
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));

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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/virtual/sessions']}>
        <SettingsProvider><SessionsList /><Where /></SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const addFiles = (files: File[]) => fireEvent.change(screen.getByTestId('sessions-files'), { target: { files } });
const sessions = () => screen.findAllByTestId('session');
const decoded = () => new URL(`http://x${screen.getByTestId('where').textContent}`).searchParams;

let idb: FakeIdb;
beforeEach(async () => {
  userId = 'ana';
  token = null; // signed out of the account's laps unless a test says otherwise
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
    expect(screen.getByText(/stay in your browser/)).toBeInTheDocument();
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
    expect(screen.getByTestId('where').textContent?.startsWith('/virtual/compare?a=')).toBe(true);
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

describe('laps in the account', () => {
  const asAccountLap = (lap: LapFile, id: string, extra: Partial<AccountLap> = {}): AccountLap => ({
    id,
    game: lap.header.game,
    track: lap.header.track.name,
    car: lap.header.car.name,
    lapNumber: lap.header.lap.number,
    timeMs: lap.header.lap.timeMs,
    valid: lap.header.lap.valid,
    startedAt: lap.header.startedAt,
    sampleCount: lap.header.sampleCount,
    sizeBytes: 1000,
    createdAt: '2026-11-12T10:00:00.000Z',
    deviceName: 'Rig',
    ...extra,
  });
  const invalid = asAccountLap(mine, 'srv-3', { lapNumber: 9, timeMs: 39_000, valid: false, sampleCount: 5 });
  let fileCalls: string[];
  beforeEach(async () => {
    token = 'token';
    fileCalls = [];
    const list = [asAccountLap(mine, 'srv-1'), asAccountLap(best, 'srv-2'), invalid];
    const bytes: Record<string, Uint8Array> = { 'srv-1': await gzipLap(mine), 'srv-2': await gzipLap(best) };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/sim/laps') return new Response(JSON.stringify({ laps: list }), { status: 200 });
      const one = /^\/api\/sim\/laps\/([\w-]+)\/file$/.exec(path);
      if (one && bytes[one[1]]) {
        fileCalls.push(one[1]);
        return new Response(bytes[one[1]], { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the laps grouped into one session, with the invalid one marked, and a lap in both places once', async () => {
    renderSessions();
    addFiles([await file(mine, 'mine.xlap.gz')]); // the same lap as srv-1
    await screen.findByTestId('import-report');
    await waitFor(() => expect(screen.getAllByTestId('session-lap')).toHaveLength(3));
    const list = await sessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveTextContent('Sample Ring · Sample Car');
    expect(list[0]).toHaveTextContent('Laps: 3 (2 valid)');
    expect(list[0]).toHaveTextContent('Best: 0:41.076');
    const rows = within(list[0]).getAllByTestId('session-lap');
    expect(rows.some((row) => row.textContent?.includes('0:39.000') && row.textContent.includes('not valid'))).toBe(true);
    expect(screen.queryByTestId('sessions-empty')).not.toBeInTheDocument();
  });

  it('says to connect Xpeed Companion when there are no laps at all', async () => {
    token = null;
    renderSessions();
    expect(await screen.findByTestId('sessions-empty')).toHaveTextContent('Connect Xpeed Companion and drive');
    expect(screen.getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
  });

  it('opens a lap from the account by downloading it once and keeping it on the device', async () => {
    renderSessions();
    const [session] = await waitFor(async () => {
      const list = await sessions();
      expect(within(list[0]).getAllByTestId('session-lap')).toHaveLength(3);
      return list;
    });
    // Nothing was downloaded to show the list.
    expect(fileCalls).toEqual([]);
    expect(await listLaps('ana')).toHaveLength(0);
    const slower = within(session).getAllByTestId('session-lap').find((row) => row.textContent?.includes('0:41.390'))!;
    fireEvent.click(within(slower).getByRole('button', { name: 'Compare with best' }));
    const id = decoded().get('a')!;
    expect(id).toMatch(/^ana\|sample\|Sample Ring\|Sample Car\|.*\|7\|41390\|/);

    const first = await openLap('ana', id);
    expect(first?.header.lap.number).toBe(7);
    expect(fileCalls).toEqual(['srv-1']);
    expect(await listLaps('ana')).toHaveLength(1);
    // The second open (by the identity alone, as a link may carry it) is from the device.
    const second = await openLap('ana', id.slice('ana|'.length));
    expect(second?.header.lap.number).toBe(7);
    expect(fileCalls).toEqual(['srv-1']);
  });
});
