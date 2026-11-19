import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { boardKey, fakeSocialState, ranked, type FakeSocialState } from '@/test/social-fake-server';
import { ref } from '@/test/v1-fake-server';
import { whereNow } from '@/test/sim-render';
import { LeaderboardScreen } from './LeaderboardScreen';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');

/** A board with two compounds: the whole board, soft (4 drivers, me second) and medium (me not on it). */
function seeded(extra: { theoretical?: boolean; compounds?: string[] } = {}): FakeSocialState {
  const state = fakeSocialState();
  const all = ranked([
    { handle: 'fast_one', displayName: 'Fast One', timeMs: 98_000 },
    { handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 99_000, isMe: true },
    { handle: 'slow_one', displayName: 'Slow One', timeMs: 101_000 },
    { handle: 'soft_only', displayName: 'Soft Only', timeMs: 102_000 },
  ]);
  const soft = ranked([
    { handle: 'soft_only', displayName: 'Soft Only', timeMs: 97_500 },
    { handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 99_000, isMe: true },
  ]);
  const medium = ranked([{ handle: 'fast_one', displayName: 'Fast One', timeMs: 98_000 }, { handle: 'slow_one', displayName: 'Slow One', timeMs: 101_000 }, { handle: 'third_one', displayName: 'Third One', timeMs: 103_000 }]);
  const byTyre: Record<string, typeof all> = { Soft: soft, Medium: medium };
  for (const name of Object.keys(byTyre)) if (extra.compounds && !extra.compounds.includes(name)) delete byTyre[name];
  state.boards.set(boardKey(monza.id, ferrari.id, 'public'), {
    entries: all, game: 'lmu', track: { ...monza, lengthM: 5793 }, car: { ...ferrari, class: 'Hypercar' }, byTyre,
    theoretical: extra.theoretical === false ? {} : {
      '': { timeMs: 96_000, sectors: [{ index: 1, ms: 31_000, handle: 'fast_one' }, { index: 2, ms: 32_000, handle: 'lap_fan' }, { index: 3, ms: 33_000, handle: 'fast_one' }] },
      Soft: { timeMs: 95_500, sectors: [{ index: 1, ms: 30_500, handle: 'soft_only' }, { index: 2, ms: 32_000, handle: 'lap_fan' }, { index: 3, ms: 33_000, handle: 'soft_only' }] },
    },
  });
  return state;
}

const route = (extra = '') => `/virtual/leaderboards?game=lmu&track=${monza.id}&car=${ferrari.id}${extra}`;
const open = async (state: FakeSocialState, at = route()) => {
  const view = renderSocial(<LeaderboardScreen />, { state, route: at });
  await screen.findByTestId('board-table');
  return view;
};
const rows = () => screen.getAllByTestId('board-row');
const handles = () => rows().map((row) => within(row).getByTestId('driver-name').getAttribute('href'));
const chip = (tyre: string) => screen.getAllByTestId('tyre-chip').find((node) => node.getAttribute('data-tyre') === tyre)!;

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the leaderboard screen with tyres', () => {
  it('shows a chip row with All and each compound, with its drivers, when the board has two or more compounds', async () => {
    const state = seeded();
    await open(state);
    const row = await screen.findByTestId('board-tyres');
    expect(within(row).getAllByTestId('tyre-chip').map((node) => node.getAttribute('data-tyre'))).toEqual(['', 'Medium', 'Soft']);
    expect(chip('Medium')).toHaveTextContent('Medium3');
    expect(chip('Soft')).toHaveTextContent('Soft2');
    expect(within(chip('Soft')).getByLabelText('Drivers: 2')).toBeInTheDocument();
    expect(chip('')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Soft')).toHaveAttribute('aria-pressed', 'false');
    // The first read has no tyre in it.
    expect(callsTo(state, 'GET', '/leaderboard')[0].params.tyre).toBeUndefined();
  });

  it('hides the chips when the board has one compound or none', async () => {
    await open(seeded({ compounds: ['Soft'] }));
    await waitFor(() => expect(screen.getByTestId('board-theoretical')).toBeInTheDocument());
    expect(screen.queryByTestId('board-tyres')).not.toBeInTheDocument();
    cleanup();
    await open(seeded({ compounds: [] }));
    await waitFor(() => expect(screen.getByTestId('board-theoretical')).toBeInTheDocument());
    expect(screen.queryByTestId('board-tyres')).not.toBeInTheDocument();
  });

  it('choosing a tyre puts it in the address, asks for that tyre, and the table, the podium and "your position" follow', async () => {
    const state = seeded();
    await open(state);
    await screen.findByTestId('board-tyres');
    expect(handles()[0]).toBe('/virtual/drivers/fast_one');
    expect(screen.getByTestId('board-me-place')).toHaveTextContent('2nd of 4');
    fireEvent.click(chip('Soft'));
    await waitFor(() => expect(handles()[0]).toBe('/virtual/drivers/soft_only'));
    expect(rows()).toHaveLength(2);
    expect(whereNow(screen.getByTestId('where')).searchParams.get('tyre')).toBe('Soft');
    expect(callsTo(state, 'GET', '/leaderboard').some((call) => call.params.tyre === 'Soft')).toBe(true);
    expect(callsTo(state, 'GET', '/leaderboard/me').some((call) => call.params.tyre === 'Soft')).toBe(true);
    await waitFor(() => expect(screen.getByTestId('board-me-place')).toHaveTextContent('2nd of 2'));
    // The chips stay (they cover the whole board) and the chosen one is marked.
    expect(chip('Soft')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Medium')).toBeInTheDocument();
    // "All" clears it from the address.
    fireEvent.click(chip(''));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(whereNow(screen.getByTestId('where')).searchParams.has('tyre')).toBe(false);
  });

  it('opens on the tyre the address names (a shareable link), keeps the other parts of the address, and says why you are not listed', async () => {
    const state = seeded();
    await open(state, route('&tyre=Medium&scope=public'));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(chip('Medium')).toHaveAttribute('aria-pressed', 'true');
    expect(callsTo(state, 'GET', '/leaderboard')[0].params).toMatchObject({ tyre: 'Medium', scope: 'public', game: 'lmu' });
    expect(await screen.findByTestId('board-not-listed')).toHaveTextContent('no valid lap on Medium');
    // Switching to the friends board keeps the tyre in the address.
    fireEvent.mouseDown(screen.getByTestId('scope-friends'), { button: 0, ctrlKey: false });
    await waitFor(() => expect(whereNow(screen.getByTestId('where')).searchParams.get('scope')).toBe('friends'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('tyre')).toBe('Medium');
  });

  it('says there are no laps on a tyre when the board of that tyre is empty, and keeps the chips so it can be cleared', async () => {
    const state = seeded({ compounds: ['Soft'] });
    renderSocial(<LeaderboardScreen />, { state, route: route('&tyre=Hard') });
    expect(await screen.findByTestId('board-empty')).toHaveTextContent('No laps on this tyre');
    // One compound only, but the address names a tyre: the chips stay (with the named tyre) so the person can clear it.
    expect(await screen.findByTestId('board-tyres')).toBeInTheDocument();
    expect(chip('Hard')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip(''));
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it('shows the theoretical best above the table: the time, each sector with its time and driver, and it follows the tyre', async () => {
    await open(seeded());
    const line = await screen.findByTestId('board-theoretical');
    expect(line).toHaveTextContent('Theoretical best');
    expect(within(line).getByTestId('theoretical-time')).toHaveTextContent('1:36.000');
    const sectors = within(line).getAllByTestId('theoretical-sector');
    expect(sectors.map((node) => node.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['S1 31.000 @fast_one', 'S2 32.000 @lap_fan', 'S3 33.000 @fast_one']);
    expect(within(sectors[0]).getByRole('link')).toHaveAttribute('href', '/virtual/drivers/fast_one');
    // It is above the table.
    expect(line.compareDocumentPosition(screen.getByTestId('board-table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(chip('Soft'));
    await waitFor(() => expect(within(screen.getByTestId('board-theoretical')).getByTestId('theoretical-time')).toHaveTextContent('1:35.500'));
  });

  it('leaves the theoretical best out when the server sends none', async () => {
    await open(seeded({ theoretical: false }));
    await screen.findByTestId('board-tyres');
    expect(screen.queryByTestId('board-theoretical')).not.toBeInTheDocument();
  });

  it('writes the strings in Portuguese and Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    await open(seeded());
    expect(await screen.findByTestId('board-theoretical')).toHaveTextContent('Melhor teórica');
    expect(within(screen.getByTestId('board-tyres')).getByText('Pneu')).toBeInTheDocument();
    expect(chip('')).toHaveTextContent('Todos');
    expect(within(chip('Soft')).getByLabelText('Pilotos: 2')).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('es-ES');
    await open(seeded());
    expect(await screen.findByTestId('board-theoretical')).toHaveTextContent('Mejor teórica');
    expect(within(screen.getByTestId('board-tyres')).getByText('Neumático')).toBeInTheDocument();
  });
});
