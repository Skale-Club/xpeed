import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { makeLapFixtures } from '@/test/lap-fixture';
import { renderSim, whereNow } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, type FakeV1State } from '@/test/v1-fake-server';
import { chooseOption, waitForOptions } from '@/test/select';
import { CompareScreen } from './CompareScreen';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock);
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const [mine, best] = makeLapFixtures();
const elsewhere: LapFile = { ...best, header: { ...best.header, track: { name: 'Another Ring', lengthM: best.header.track.lengthM }, lap: { ...best.header.lap, number: 9 } } };

const track = ref('Sample Ring');
const car = ref('Sample Car');
const base = { game: 'sample', track, car };
// The personal best is the fastest valid lap of the track and car: `bestLap`.
const myLap = v1Lap({ ...base, lapNumber: 7, timeMs: mine.header.lap.timeMs, startedAt: '2026-11-10T12:10:00.000Z' });
const bestLap = v1Lap({ ...base, lapNumber: 5, timeMs: best.header.lap.timeMs, startedAt: '2026-11-09T12:00:00.000Z' });
const otherLap = v1Lap({ game: 'sample', track: ref('Another Ring'), car, lapNumber: 9, timeMs: best.header.lap.timeMs + 5000, startedAt: '2026-11-08T12:00:00.000Z' });

let state: FakeV1State;
let idb: FakeIdb;
const fileRequests = () => state.requests.filter((request) => request.path.endsWith('/file')).map((request) => request.path);

beforeEach(async () => {
  localStorage.clear();
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
  const [a, b, c] = await Promise.all([gzipLap(mine), gzipLap(best), gzipLap(elsewhere)]);
  state = fakeV1State({
    laps: [myLap, bestLap, otherLap],
    files: new Map([[myLap.id, a], [bestLap.id, b], [otherLap.id, c]]),
    tracks: [{ id: track.id, game: 'sample', name: track.name, lengthM: 4000, lapCount: 2, validLapCount: 2, sessionCount: 1, carCount: 1, bestLapMs: 1, lastDrivenAt: '2026-11-10T12:10:00.000Z' }],
    cars: [{ id: car.id, game: 'sample', name: car.name, brand: null, class: null, lapCount: 3, validLapCount: 3, sessionCount: 1, trackCount: 2, bestLapMs: 1, lastDrivenAt: '2026-11-10T12:10:00.000Z' }],
  });
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const open = (route: string) => renderSim(<CompareScreen />, { state, route });
/** The header shows a dash until both laps are down; this waits for the gap itself. */
const gapReady = () => waitFor(() => expect(screen.getByTestId('final-gap')).not.toHaveTextContent('–'));
const search = () => whereNow(screen.getByTestId('where')).searchParams;

describe('the reference', () => {
  it('is the personal best of the same track and car by default', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    await waitFor(() => expect(screen.getByTestId('final-gap')).toHaveTextContent(/^\+0\.3\d\d s$/));
    const reference = screen.getByTestId('slot-reference');
    expect(reference).toHaveTextContent('My personal best (default)');
    expect(reference).toHaveTextContent('Lap 5');
    expect(fileRequests().sort()).toEqual([`/laps/${bestLap.id}/file`, `/laps/${myLap.id}/file`].sort());
    // The PB was found from /v1/pbs, narrowed to the game of the lap.
    expect(state.requests.find((request) => request.path === '/pbs')!.params.game).toBe('sample');
    expect(search().get('b')).toBeNull(); // a default is not written into the address
  });

  it('is what the address says when it names one: deep links carry server lap ids', async () => {
    open(`/virtual/compare?a=${bestLap.id}&b=${myLap.id}`);
    await waitFor(() => expect(screen.getByTestId('final-gap')).toHaveTextContent(/^-0\.3\d\d s$/));
    expect(screen.getByTestId('slot-lap')).toHaveTextContent('Lap 5');
    expect(screen.getByTestId('slot-reference')).toHaveTextContent('Lap 7');
    expect(screen.getByTestId('slot-reference')).not.toHaveTextContent('default');
    expect(fileRequests()).toHaveLength(2);
  });

  it('is nothing when the lap is the personal best itself, and says so', async () => {
    open(`/virtual/compare?a=${bestLap.id}`);
    await waitFor(() => expect(screen.getByTestId('slot-reference')).toHaveTextContent('This is your personal best'));
    expect(screen.getByTestId('final-gap')).toHaveTextContent('–');
    expect(screen.getByTestId('delta-words')).toHaveTextContent('This is your best: choose a reference.');
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument(); // the lap is still looked at
    expect(screen.getByTestId('slot-lap')).toHaveTextContent('Personal best');
  });

  it('can be changed with the picker, which starts on the same track and car, and then the address names it', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    await gapReady();
    fireEvent.click(within(screen.getByTestId('slot-reference')).getByRole('button', { name: 'Change' }));
    const picker = await screen.findByTestId('lap-picker');
    await waitFor(() => expect(within(picker).getAllByTestId('picker-lap').length).toBeGreaterThan(0));
    // The lap being compared cannot be picked as its own reference.
    const offered = within(picker).getAllByTestId('picker-lap');
    expect(offered.map((button) => [button.getAttribute('data-lap-id'), (button as HTMLButtonElement).disabled])).toEqual([[myLap.id, true], [bestLap.id, false]]);
    fireEvent.click(offered[1]);
    await waitFor(() => expect(search().get('b')).toBe(bestLap.id));
    expect(search().get('a')).toBe(myLap.id);
    expect(screen.queryByTestId('lap-picker')).not.toBeInTheDocument();
  });

  it('can go back to the personal best after another one was chosen', async () => {
    open(`/virtual/compare?a=${myLap.id}&b=${otherLap.id}`);
    await waitFor(() => expect(screen.getByTestId('different-tracks')).toBeInTheDocument());
    fireEvent.click(await within(screen.getByTestId('slot-reference')).findByRole('button', { name: 'Use my personal best as the reference' }));
    await waitFor(() => expect(search().get('b')).toBeNull());
    await gapReady();
  });

  it('swaps the lap and the reference', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    await gapReady();
    fireEvent.click(screen.getByRole('button', { name: 'Swap the lap and the reference' }));
    await waitFor(() => expect(search().get('a')).toBe(bestLap.id));
    expect(search().get('b')).toBe(myLap.id);
    await waitFor(() => expect(screen.getByTestId('final-gap')).toHaveTextContent(/^-0\.3/));
  });
});

describe('laps that cannot be compared', () => {
  it('is refused with the reason, and the lap alone is still looked at', async () => {
    open(`/virtual/compare?a=${myLap.id}&b=${otherLap.id}`);
    expect(await screen.findByTestId('different-tracks')).toHaveTextContent('different tracks');
    expect(screen.getByTestId('final-gap')).toHaveTextContent('–');
    expect(screen.getByTestId('delta-words')).toHaveTextContent('These laps cannot be compared.');
    expect(screen.queryByTestId('time-changes')).not.toBeInTheDocument();
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument();
  });
});

describe('downloading', () => {
  it('shows that the lap is on its way', async () => {
    state.delayMs = 30;
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    expect(await screen.findAllByTestId('lap-downloading')).toHaveLength(2);
    await gapReady();
    expect(screen.queryByTestId('lap-downloading')).not.toBeInTheDocument();
  });

  it('says when a download fails, offers to try again, and goes on when it works', async () => {
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    const failed = await screen.findAllByTestId('lap-failed');
    expect(failed[0]).toHaveTextContent('could not be downloaded');
    expect(screen.queryByTestId('lap-analysis')).not.toBeInTheDocument();

    state.failing = null;
    fireEvent.click(within(screen.getByTestId('slot-lap')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('lap-numbers')).toBeInTheDocument());
    expect(within(screen.getByTestId('slot-lap')).queryByTestId('lap-failed')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('slot-reference')).getByRole('button', { name: 'Try again' }));
    await gapReady();
  });

  it('says a lap is no longer in the account, without offering a retry that cannot help', async () => {
    state.files.delete(bestLap.id);
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    const gone = await screen.findByTestId('lap-failed');
    expect(gone).toHaveTextContent('no longer in your account');
    expect(within(screen.getByTestId('slot-reference')).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('lap-numbers')).toBeInTheDocument()); // the other lap is still looked at
  });

  it('refuses a file that is not a lap', async () => {
    state.files.set(myLap.id, new TextEncoder().encode('not a lap'));
    open(`/virtual/compare?a=${myLap.id}`);
    expect(await screen.findByTestId('lap-failed')).toHaveTextContent('not a valid lap file');
  });

  it('downloads a lap once: coming back to it is read from the device', async () => {
    const first = open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    await gapReady();
    first.unmount();
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    await gapReady();
    expect(fileRequests()).toHaveLength(2);
  });
});

describe('finding a lap', () => {
  it('starts with the picker, which goes game, track, then the laps of that track newest first, and picking one opens it', async () => {
    const { container } = open('/virtual/compare');
    const picker = await screen.findByTestId('lap-picker');
    // One game: nothing to choose.
    await waitFor(() => expect(within(picker).getByTestId('picker-game')).toHaveTextContent('SAMPLE'));
    expect(within(picker).getByTestId('picker-hint')).toHaveTextContent('Now choose a track');
    await waitForOptions(() => within(picker).getByTestId('picker-track'), (labels) => labels.filter((label) => label === 'Sample Ring').length === 1);
    chooseOption(within(picker).getByTestId('picker-track'), 'Sample Ring');

    const list = await within(picker).findByTestId('picker-laps');
    expect(within(list).getAllByTestId('picker-lap').map((button) => button.getAttribute('data-lap-id'))).toEqual([myLap.id, bestLap.id]); // newest first
    expect(within(list).getByText('Personal best')).toBeInTheDocument();
    const lapsRequest = state.requests.find((request) => request.path === '/laps')!;
    expect(lapsRequest.params).toMatchObject({ game: 'sample', track: track.id });

    chooseOption(within(picker).getByTestId('picker-car'), 'Sample Car');
    await waitFor(() => expect(state.requests.some((request) => request.path === '/laps' && request.params.car === car.id)).toBe(true));

    fireEvent.click(await within(picker).findByRole('button', { name: /Lap 7/ }));
    await waitFor(() => expect(search().get('a')).toBe(myLap.id));
    await gapReady(); // and its reference is the personal best
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('invites to install and connect Xpeed Companion when the account has no laps', async () => {
    state.laps = [];
    open('/virtual/compare');
    const empty = await screen.findByTestId('picker-empty');
    expect(within(empty).getByRole('link', { name: 'Get Xpeed Companion' })).toHaveAttribute('href', '/companion');
    expect(within(empty).getByRole('link', { name: 'Connect it to your account' })).toHaveAttribute('href', '/virtual/companion');
  });

  it('offers no file input and no drop zone, and no sample laps', async () => {
    const { container } = open(`/virtual/compare?a=${myLap.id}`);
    await waitFor(() => expect(screen.getByTestId('lap-numbers')).toBeInTheDocument());
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/sample laps|Open lap files|drop/i)).not.toBeInTheDocument();
  });
});

describe('the lap picker of the compare screen', () => {
  it('has its game, track and car as one wrapping row of compact drop-downs with the name inside each', async () => {
    open('/virtual/compare');
    const picker = await screen.findByTestId('lap-picker');
    const bar = within(picker).getByTestId('picker-filters');
    expect(bar).toHaveClass('flex', 'flex-wrap', 'items-center', 'gap-2');
    for (const chrome of ['grid', 'border', 'bg-card']) expect(bar).not.toHaveClass(chrome);
    for (const id of ['picker-game', 'picker-track', 'picker-car']) expect(within(bar).getByTestId(id)).toHaveClass('h-8', 'text-xs');
    expect(within(bar).getByRole('combobox', { name: 'Track' })).toHaveTextContent(/^Track/);
    expect(bar.querySelector('label')).toBeNull();
  });
});
