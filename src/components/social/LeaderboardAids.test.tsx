import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { boardKey, fakeSocialState, ranked, type FakeSocialState } from '@/test/social-fake-server';
import { ref } from '@/test/v1-fake-server';
import { whereNow } from '@/test/sim-render';
import { AidIcons } from './BoardAids';
import { LeaderboardScreen } from './LeaderboardScreen';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');

const NONE = { tcMax: 0, absMax: 0, stability: 0, autoShift: false, idealLine: false };
const lap = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * One board: four drivers on the open board, two of them on "No TC & ABS" (one of those with every aid off). Rows carry their aids, which is
 * what the icons show; the one with no aids (a lap from before they were recorded) shows nothing.
 */
function seeded(extra: { empty?: boolean } = {}): FakeSocialState {
  const state = fakeSocialState();
  const all = ranked([
    { handle: 'fast_one', displayName: 'Fast One', timeMs: 98_000, lapId: lap(1), aids: { tcMax: 3, absMax: 2, autoShift: true } },
    { handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 99_000, lapId: lap(2), isMe: true, aids: NONE },
    { handle: 'slow_one', displayName: 'Slow One', timeMs: 101_000, lapId: lap(3), aids: { tcMax: 0, absMax: 0, idealLine: true } },
    { handle: 'old_one', displayName: 'Old One', timeMs: 102_000, lapId: lap(4), aids: null },
  ]);
  const noTcAbs = [all[1], all[2]];
  const none = [all[1]];
  state.boards.set(boardKey(monza.id, ferrari.id, 'public'), {
    entries: all, game: 'lmu', track: { ...monza, lengthM: 5793 }, car: { ...ferrari, class: 'Hypercar' },
    byAids: extra.empty ? {} : { no_tc_abs: noTcAbs.map((entry) => entry.lapId), none: none.map((entry) => entry.lapId) },
    theoretical: {
      '': { timeMs: 96_000, sectors: [{ index: 1, ms: 31_000, handle: 'fast_one' }, { index: 2, ms: 32_000, handle: 'lap_fan' }, { index: 3, ms: 33_000, handle: 'fast_one' }] },
      'aids:none': { timeMs: 99_000, sectors: [{ index: 1, ms: 33_000, handle: 'lap_fan' }, { index: 2, ms: 33_000, handle: 'lap_fan' }, { index: 3, ms: 33_000, handle: 'lap_fan' }] },
    },
  });
  return state;
}

const route = (extra = '') => `/virtual/leaderboards?game=lmu&track=${monza.id}&car=${ferrari.id}${extra}`;
const open = async (state: FakeSocialState, at = route()) => {
  renderSocial(<LeaderboardScreen />, { state, route: at });
  await screen.findByTestId('board-table');
};
const rows = () => screen.getAllByTestId('board-row');
const handles = () => rows().map((row) => within(row).getByTestId('driver-name').getAttribute('href'));
const chip = (aids: string) => screen.getAllByTestId('aid-chip').find((node) => node.getAttribute('data-aids') === aids)!;

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the leaderboard screen with aid boards', () => {
  it('shows an Aids chip row with All, No TC & ABS and No aids and their drivers, and the beta line', async () => {
    const state = seeded();
    await open(state);
    const row = await screen.findByTestId('board-aids');
    expect(within(row).getAllByTestId('aid-chip').map((node) => node.getAttribute('data-aids'))).toEqual(['all', 'no_tc_abs', 'none']);
    expect(chip('all')).toHaveTextContent('All');
    expect(chip('no_tc_abs')).toHaveTextContent('No TC & ABS2');
    expect(chip('none')).toHaveTextContent('No aids1');
    expect(within(chip('none')).getByLabelText('Drivers: 1')).toBeInTheDocument();
    expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: 'Filter by driving aids' })).toBe(row);
    // One short line says it is beta and why.
    expect(within(row).getByTestId('aids-beta')).toHaveTextContent('beta');
    expect(within(row).getByTestId('aids-beta')).toHaveTextContent('what the game reports');
    // The open board asks for no aids.
    expect(callsTo(state, 'GET', '/leaderboard')[0].params.aids).toBeUndefined();
  });

  it('hides the row when neither filtered board has a driver', async () => {
    const state = seeded({ empty: true });
    await open(state);
    await waitFor(() => expect(callsTo(state, 'GET', '/leaderboards/conditions')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('board-me-place')).toBeInTheDocument());
    expect(screen.queryByTestId('board-aids')).not.toBeInTheDocument();
  });

  it('choosing a board puts it in the address, asks for it, and the table and "your position" follow; All clears it', async () => {
    const state = seeded();
    await open(state);
    await screen.findByTestId('board-aids');
    expect(handles()).toHaveLength(4);
    fireEvent.click(chip('no_tc_abs'));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(handles()).toEqual(['/virtual/drivers/lap_fan', '/virtual/drivers/slow_one']);
    expect(whereNow(screen.getByTestId('where')).searchParams.get('aids')).toBe('no_tc_abs');
    expect(callsTo(state, 'GET', '/leaderboard').some((call) => call.params.aids === 'no_tc_abs')).toBe(true);
    expect(callsTo(state, 'GET', '/leaderboard/me').some((call) => call.params.aids === 'no_tc_abs')).toBe(true);
    expect(callsTo(state, 'GET', '/leaderboards/conditions').some((call) => call.params.aids === 'no_tc_abs')).toBe(true);
    expect(chip('no_tc_abs')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('none')).toBeInTheDocument();
    fireEvent.click(chip('none'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    // The theoretical best follows the board.
    await waitFor(() => expect(within(screen.getByTestId('board-theoretical')).getByTestId('theoretical-time')).toHaveTextContent('1:39.000'));
    fireEvent.click(chip('all'));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(whereNow(screen.getByTestId('where')).searchParams.has('aids')).toBe(false);
  });

  it('opens on the board the address names, keeps the rest of the address, and says so when it is empty', async () => {
    const state = seeded();
    await open(state, route('&aids=none&scope=public'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(chip('none')).toHaveAttribute('aria-pressed', 'true');
    expect(callsTo(state, 'GET', '/leaderboard')[0].params).toMatchObject({ aids: 'none', scope: 'public', game: 'lmu' });
    cleanup();
    // An address that names a board nobody is on keeps the chips, so it can be cleared.
    renderSocial(<LeaderboardScreen />, { state: seeded({ empty: true }), route: route('&aids=none') });
    expect(await screen.findByTestId('board-empty')).toHaveTextContent('No laps with these aids');
    expect(await screen.findByTestId('board-aids')).toBeInTheDocument();
    expect(await screen.findByTestId('board-not-listed')).toHaveTextContent('none of your laps');
    fireEvent.click(chip('all'));
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it('an address with an unknown aids value is the open board', async () => {
    await open(seeded(), route('&aids=bogus'));
    expect(rows()).toHaveLength(4);
  });

  it('draws the aids of each row with an accessible label, and nothing for a lap with none', async () => {
    await open(seeded());
    const [fast, me, slow, old] = rows();
    expect(within(fast).getByRole('img', { name: 'Driving aids: Traction control 3, ABS 2, Automatic gears' })).toBeInTheDocument();
    expect(within(fast).getByRole('img').getAttribute('title')).toBe('Driving aids: Traction control 3, ABS 2, Automatic gears');
    expect(within(fast).getByTestId('aid-icons').querySelectorAll('[data-aid]')).toHaveLength(3);
    expect(within(me).getByRole('img', { name: 'No driving aids' })).toBeInTheDocument();
    expect(within(slow).getByRole('img', { name: 'Driving aids: Ideal line' })).toBeInTheDocument();
    expect(within(old).queryByTestId('aid-icons')).not.toBeInTheDocument();
  });

  it('writes the strings in Portuguese and Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    await open(seeded());
    expect(within(await screen.findByTestId('board-aids')).getByText('Auxílios')).toBeInTheDocument();
    expect(chip('none')).toHaveTextContent('Sem auxílios');
    expect(chip('no_tc_abs')).toHaveTextContent('Sem TC e ABS');
    expect(screen.getByTestId('aids-beta')).toHaveTextContent('jogo a jogo');
    expect(within(rows()[0]).getByRole('img', { name: 'Auxílios de pilotagem: Controle de tração 3, ABS 2, Câmbio automático' })).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('es-ES');
    await open(seeded());
    expect(within(await screen.findByTestId('board-aids')).getByText('Ayudas')).toBeInTheDocument();
    expect(chip('none')).toHaveTextContent('Sin ayudas');
    expect(chip('no_tc_abs')).toHaveTextContent('Sin TC ni ABS');
    expect(within(rows()[0]).getByRole('img', { name: 'Ayudas a la conducción: Control de tracción 3, ABS 2, Cambio automático' })).toBeInTheDocument();
  });
});

describe('AidIcons', () => {
  it('shows nothing for no aids, and for aids with nothing on that do not say TC and ABS are off', () => {
    const { container, rerender } = render(<AidIcons aids={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AidIcons aids={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AidIcons aids={{ autoShift: false, idealLine: false }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AidIcons aids={{ tcMax: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every aid that is on in the label, including the ones that have no icon', () => {
    render(<AidIcons aids={{ tcMax: 0, absMax: 0, stability: 0.5, autoClutch: true, autoBlip: true }} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Driving aids: Stability control, Automatic clutch, Automatic throttle blip');
  });
});
