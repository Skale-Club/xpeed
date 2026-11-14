import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { savedStorageKey } from '@/lib/sim/compare-recent';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { makeLapFixtures } from '@/test/lap-fixture';
import { renderSim, whereNow } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { chooseOption, selectOptions } from '@/test/select';
import { CompareScreen } from './CompareScreen';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock);
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const [mine, best] = makeLapFixtures();
const withTime = (lap: LapFile, number: number, timeMs: number): LapFile => ({ ...lap, header: { ...lap.header, lap: { ...lap.header.lap, number, timeMs } } });

const track = ref('Sample Ring');
const car = ref('Sample Car');
const otherCar = ref('Other Car');
const base = { game: 'sample', track, car };

// The newest session has my lap; the one before has the personal best; the oldest has a slower lap.
const sessionNew = v1Session({ game: 'sample', track, car, startedAt: '2026-11-10T12:00:00.000Z', endedAt: '2026-11-10T12:30:00.000Z', lapCount: 1 });
const sessionBest = v1Session({ game: 'sample', track, car, startedAt: '2026-11-09T12:00:00.000Z', endedAt: '2026-11-09T12:30:00.000Z', lapCount: 1 });
const sessionOld = v1Session({ game: 'sample', track, car, startedAt: '2026-11-01T12:00:00.000Z', endedAt: '2026-11-01T12:30:00.000Z', lapCount: 1 });
const myLap = v1Lap({ ...base, sessionId: sessionNew.id, lapNumber: 7, timeMs: mine.header.lap.timeMs, startedAt: '2026-11-10T12:10:00.000Z' });
const bestLap = v1Lap({ ...base, sessionId: sessionBest.id, lapNumber: 5, timeMs: best.header.lap.timeMs, startedAt: '2026-11-09T12:00:00.000Z' });
const oldLap = v1Lap({ ...base, sessionId: sessionOld.id, lapNumber: 3, timeMs: best.header.lap.timeMs + 3000, startedAt: '2026-11-01T12:00:00.000Z' });
const carLap = v1Lap({ game: 'sample', track, car: otherCar, lapNumber: 2, timeMs: best.header.lap.timeMs + 1500, startedAt: '2026-11-05T12:00:00.000Z' });

let state: FakeV1State;
let idb: FakeIdb;
beforeEach(async () => {
  localStorage.clear();
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
  const [a, b, c, d] = await Promise.all([gzipLap(mine), gzipLap(best), gzipLap(withTime(best, 3, oldLap.timeMs)), gzipLap(withTime(best, 2, carLap.timeMs))]);
  state = fakeV1State({
    sessions: [sessionNew, sessionBest, sessionOld],
    laps: [myLap, bestLap, oldLap, carLap],
    files: new Map([[myLap.id, a], [bestLap.id, b], [oldLap.id, c], [carLap.id, d]]),
  });
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = (route: string) => renderSim(<CompareScreen />, { state, route });
const search = () => whereNow(screen.getByTestId('where')).searchParams;
const gapReady = () => waitFor(() => expect(screen.getByTestId('final-gap')).not.toHaveTextContent('–'));
const kept = () => JSON.parse(localStorage.getItem(savedStorageKey('ana')) ?? '[]') as Array<{ a: string; b: string | null; pinned: boolean }>;

describe('the two-lap header', () => {
  it('shows both laps with their times big and the gap between them, red when the lap is slower', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    await gapReady();
    expect(screen.getByTestId('slot-lap-time')).toHaveTextContent(/^0:41\.\d{3}$/);
    expect(screen.getByTestId('slot-reference-time')).toHaveTextContent(/^0:41\.\d{3}$/);
    expect(screen.getByTestId('slot-lap')).toHaveAttribute('data-side', 'lap');
    expect(screen.getByTestId('slot-reference')).toHaveAttribute('data-side', 'reference');
    expect(screen.getByTestId('final-gap')).toHaveAttribute('data-tone', 'loss');
    expect(screen.getByTestId('delta-words')).toHaveTextContent('slower than the reference');
  });

  it('turns the gap green when the lap is faster, by swapping the two', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    await gapReady();
    fireEvent.click(screen.getByTestId('swap'));
    await waitFor(() => expect(search().get('a')).toBe(bestLap.id));
    await waitFor(() => expect(screen.getByTestId('final-gap')).toHaveAttribute('data-tone', 'gain'));
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^-0\.3\d\d s$/);
    expect(screen.getByTestId('delta-words')).toHaveTextContent('faster than the reference');
  });

  it('cannot be swapped with no reference', async () => {
    open(`/virtual/compare?a=${bestLap.id}`); // the personal best itself: no default reference
    await waitFor(() => expect(screen.getByTestId('slot-reference')).toHaveTextContent('This is your personal best'));
    expect(screen.getByTestId('swap')).toBeDisabled();
  });
});

describe('the charts', () => {
  it('say in words, for a screen reader, where each line goes from and to', async () => {
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    await gapReady();
    const labels = screen.getAllByRole('img').map((image) => image.getAttribute('aria-label') ?? '');
    expect(labels.some((label) => /Lap: from -?[\d.]+ to -?[\d.]+; Reference: from -?[\d.]+ to -?[\d.]+/.test(label))).toBe(true);
    expect(labels.some((label) => /^Gap to the reference \(s\)\. Gap to the reference: from /.test(label))).toBe(true);
  });
});

describe('the quick references', () => {
  it('offers my best, marked as the one in use when it is the default reference', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    const mineButton = await screen.findByTestId('quick-mine');
    await waitFor(() => expect(mineButton).toHaveAttribute('aria-pressed', 'true'));
    expect(mineButton).toHaveTextContent(/My best\s*0:41\.\d{3}/);
  });

  it('chooses the best lap of the session before this lap’s session (a reference written into the address)', async () => {
    open(`/virtual/compare?a=${bestLap.id}`);
    const previous = await screen.findByTestId('quick-previous');
    expect(previous).toHaveTextContent(/Previous session’s best\s*0:4\d\.\d{3}/);
    expect(previous).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('quick-mine')).toBeDisabled(); // this lap is the personal best
    fireEvent.click(previous);
    await waitFor(() => expect(search().get('b')).toBe(oldLap.id));
    expect(search().get('a')).toBe(bestLap.id);
    await gapReady();
    expect(screen.getByTestId('final-gap')).toHaveAttribute('data-tone', 'gain'); // 3 s quicker than the oldest session's best
    expect(screen.getByTestId('quick-previous')).toHaveAttribute('aria-pressed', 'true');
  });

  it('chooses the best lap of another car on this track from a list', async () => {
    open(`/virtual/compare?a=${bestLap.id}`);
    const select = await screen.findByTestId('quick-other-car');
    expect(selectOptions(select)).toEqual([expect.stringMatching(/^Another car/), expect.stringMatching(/^Other Car · 0:\d\d\.\d{3}$/)]);
    chooseOption(select, /^Other Car/);
    await waitFor(() => expect(search().get('b')).toBe(carLap.id));
    await gapReady();
    expect(screen.getByTestId('slot-reference')).toHaveTextContent('Lap 2');
  });

  it('does not offer the previous session when there is none before this lap’s session', async () => {
    open(`/virtual/compare?a=${oldLap.id}`);
    await screen.findByTestId('quick-mine');
    await waitFor(() => expect(state.requests.some((request) => request.path === '/sessions' && request.params.track === track.id)).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('quick-previous')).not.toBeInTheDocument());
  });

  it('offers no other car when only one car was driven on the track', async () => {
    state.laps = state.laps.filter((lap) => lap.id !== carLap.id);
    open(`/virtual/compare?a=${myLap.id}`);
    await screen.findByTestId('quick-mine');
    await waitFor(() => expect(state.requests.some((request) => request.path === '/pbs' && request.params.track === track.id)).toBe(true));
    expect(screen.queryByTestId('quick-other-car')).not.toBeInTheDocument();
  });
});

describe('the saved and recent comparisons', () => {
  it('keeps what was compared as a chip, with the laps and their times, and the chip of the one on screen is marked', async () => {
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    const chip = await screen.findByTestId('saved-chip');
    expect(chip).toHaveTextContent(/^Sample Ring · Lap 7 0:41\.\d{3} ⇄ Lap 5 0:41\.\d{3}/);
    expect(within(chip).getByTestId('saved-chip-link')).toHaveAttribute('aria-current', 'true');
    expect(within(chip).getByTestId('saved-chip-link')).toHaveAttribute('href', `/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    expect(kept()).toEqual([expect.objectContaining({ a: myLap.id, b: bestLap.id, pinned: false })]);
  });

  it('keeps a comparison against the personal best as "my best", so it follows the personal best', async () => {
    open(`/virtual/compare?a=${myLap.id}`);
    const chip = await screen.findByTestId('saved-chip');
    await waitFor(() => expect(chip).toHaveTextContent(/⇄ Lap 5/));
    expect(kept()[0]).toMatchObject({ a: myLap.id, b: null });
    expect(within(chip).getByTestId('saved-chip-link')).toHaveAttribute('href', `/virtual/compare?a=${myLap.id}`);
  });

  it('lists a new comparison first and opens an old one again with its chip', async () => {
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    await gapReady();
    fireEvent.click(screen.getByTestId('swap'));
    await waitFor(() => expect(screen.getAllByTestId('saved-chip')).toHaveLength(2));
    const chips = screen.getAllByTestId('saved-chip');
    expect(within(chips[0]).getByTestId('saved-chip-link')).toHaveAttribute('href', `/virtual/compare?a=${bestLap.id}&b=${myLap.id}`); // the newest
    fireEvent.click(within(chips[1]).getByTestId('saved-chip-link'));
    await waitFor(() => expect(search().get('a')).toBe(myLap.id));
    expect(search().get('b')).toBe(bestLap.id);
  });

  it('saves a comparison with the pin, which keeps it first after a reload, and lets one go with the cross', async () => {
    const first = open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    fireEvent.click(await within(await screen.findByTestId('saved-chip')).findByTestId('saved-chip-pin'));
    expect(within(screen.getByTestId('saved-chip')).getByTestId('saved-chip-pin')).toHaveAttribute('aria-pressed', 'true');
    expect(kept()[0]).toMatchObject({ pinned: true });
    first.unmount();

    open(`/virtual/compare?a=${bestLap.id}&b=${oldLap.id}`);
    await waitFor(() => expect(screen.getAllByTestId('saved-chip')).toHaveLength(2));
    const chips = screen.getAllByTestId('saved-chip');
    expect(chips[0]).toHaveAttribute('data-pinned', 'true'); // the saved one stays first although the other is newer
    expect(chips[1]).toHaveAttribute('data-pinned', 'false');

    fireEvent.click(within(chips[1]).getByTestId('saved-chip-forget'));
    await waitFor(() => expect(screen.getAllByTestId('saved-chip')).toHaveLength(1));
    expect(kept()).toHaveLength(1);
  });

  it('still shows the chips, for this visit, when the browser keeps nothing (storage that throws)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key.startsWith('xpeed.sim.compare')) throw new Error('blocked');
      return null;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    open(`/virtual/compare?a=${myLap.id}&b=${bestLap.id}`);
    const chip = await screen.findByTestId('saved-chip');
    expect(chip).toHaveTextContent('Sample Ring · Lap 7');
    // The page works as ever: the gap is there, and a pin does not break it.
    await gapReady();
    fireEvent.click(within(chip).getByTestId('saved-chip-pin'));
    expect(within(screen.getByTestId('saved-chip')).getByTestId('saved-chip-pin')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no chips before anything was compared', async () => {
    open('/virtual/compare');
    await screen.findByTestId('lap-picker');
    expect(screen.queryByTestId('saved-comparisons')).not.toBeInTheDocument();
  });
});
