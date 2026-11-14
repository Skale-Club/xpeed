import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { renderSocial } from '@/test/social-render';
import { boardKey, driver, fakeSocialState, ranked, type FakeSocialState } from '@/test/social-fake-server';
import { ref, v1Lap, v1Session } from '@/test/v1-fake-server';
import type { AdminReport } from '@/lib/sim/social-client';
import { DriverPage } from './DriverPage';
import { FriendsScreen } from './FriendsScreen';
import { LeaderboardScreen } from './LeaderboardScreen';
import { ProfileSettings } from './ProfileSettings';
import { PrivacyScreen } from './PrivacyScreen';
import { PublicSharePage } from './PublicShare';
import { RacingAdmin } from './RacingAdmin';
import { XpeedSimPanel } from '@/components/sim/XpeedSimPanel';

// The server never sends an e-mail, a phone number or the account's real name (docs/platform/API-V1.md). These tests do not believe it:
// every answer below is stuffed with such strings, in fields the screens do not use and in fields they do (a display name), and no
// screen may draw any of them.

vi.mock('@/components/sim/SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => ({ isAdmin: true, loading: false }) }));
vi.mock('@/lib/sim/library', () => ({ clearCache: async () => undefined }));
// The computers of the account, with the fields the screens must not read stuffed in (the account's e-mail, a phone, the real name).
vi.mock('@/lib/sim/xpeed-sim-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/xpeed-sim-api')>()),
  listDevices: async () => [
    { id: 'd1', name: 'RIG', created_at: '2026-11-01T10:00:00.000Z', last_seen_at: new Date().toISOString(), last_lap_at: null, revoked_at: null, email: 'ana.owner@example.com', phone: '+55 11 98765-4321', accountName: 'Ana Real Surname' },
  ],
}));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana', email: 'ana.owner@example.com', phone: '5511987654321', user_metadata: { full_name: 'Ana Real Surname' } } }) }));

const EMAIL = 'ana.owner@example.com';
const OTHER_EMAIL = 'someone.else@mail.test';
const PHONE = '+55 11 98765-4321';
const REAL_NAME = 'Ana Real Surname';
const LEAKS = [EMAIL, OTHER_EMAIL, PHONE, '5511987654321', '98765-4321', REAL_NAME, 'Real Surname', 'ana.owner', 'someone.else'];

/** Fields no screen should ever read, on every object. */
const stuff = <T extends object>(value: T): T => ({
  ...value, email: EMAIL, e_mail: OTHER_EMAIL, phone: PHONE, phoneNumber: PHONE, accountName: REAL_NAME, realName: REAL_NAME, fullName: REAL_NAME,
  account: { email: EMAIL, name: REAL_NAME }, userId: 'auth0|123', accountId: 'acct-9', contact: `${REAL_NAME} <${EMAIL}> ${PHONE}`,
});

/** Every text node of the page, one space between them (textContent glues neighbours together, which can fake an address). */
function visibleText(): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('[data-testid="where"]')) continue; // the test harness's own address line, not a screen
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ');
}

function expectNoLeaks() {
  const text = visibleText();
  const html = document.body.innerHTML;
  for (const leak of LEAKS) {
    expect(text, `the screen shows ${leak}`).not.toContain(leak);
    expect(html, `the markup carries ${leak}`).not.toContain(leak);
  }
  expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/); // no e-mail address of any kind
  expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/); // no phone number of any kind
}

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');

function seeded(): FakeSocialState {
  const state = fakeSocialState();
  state.me = stuff({ ...state.me, displayName: 'Lap Fan' });
  state.v1.tracks = [{ id: monza.id, game: 'lmu', name: 'Monza', lengthM: 5793, lapCount: 3, validLapCount: 3, sessionCount: 1, carCount: 1, bestLapMs: 99_000, lastDrivenAt: '2026-11-10T12:00:00.000Z' }];
  state.v1.cars = [{ id: ferrari.id, game: 'lmu', name: 'Ferrari 499P', brand: null, class: null, lapCount: 3, validLapCount: 3, sessionCount: 1, trackCount: 1, bestLapMs: 99_000, lastDrivenAt: '2026-11-10T12:00:00.000Z' }];
  state.v1.sessions = [v1Session({ track: monza, car: ferrari })];
  state.drivers = [
    stuff(driver({
      handle: 'rival_one', displayName: OTHER_EMAIL, personalBestsCount: 3, relation: 'friend',
      bestLaps: [stuff({ lapId: '10000000-0000-4000-8000-000000000001', game: 'lmu', track: monza, car: ferrari, timeMs: 99_000, achievedAt: '2026-11-10T12:00:00.000Z' })],
    })),
    stuff(driver({ handle: 'phone_name', displayName: PHONE, relation: 'incoming' })),
    stuff(driver({ handle: 'real_name', displayName: 'Racer 9', relation: 'none' })),
  ];
  state.friendRows = [
    stuff({ handle: 'rival_one', displayName: OTHER_EMAIL, status: 'accepted' as const, since: '2026-11-10T10:00:00.000Z' }),
    stuff({ handle: 'phone_name', displayName: PHONE, status: 'incoming' as const, since: '2026-11-10T10:00:00.000Z' }),
    stuff({ handle: 'real_name', displayName: REAL_NAME + ' ' + EMAIL, status: 'blocked' as const, since: '2026-11-10T10:00:00.000Z' }),
  ];
  const board = ranked([
    { handle: 'rival_one', displayName: OTHER_EMAIL, timeMs: 99_000 },
    { handle: 'phone_name', displayName: PHONE, timeMs: 99_500 },
    { handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 100_000, isMe: true },
  ]).map((entry) => stuff(entry));
  for (const scope of ['public', 'friends']) {
    state.boards.set(boardKey(monza.id, ferrari.id, scope), { entries: board, game: 'lmu', track: stuff({ ...monza, lengthM: 5793 }), car: stuff({ ...ferrari, class: null }) });
  }
  state.shares = [stuff({ id: '20000000-0000-4000-8000-000000000001', kind: 'lap' as const, lapId: 'l1', sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true })];
  return state;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('no screen shows an e-mail, a phone number or the account\'s real name', () => {
  it('the leaderboard, public and friends, with your row and your neighbours', async () => {
    renderSocial(<LeaderboardScreen />, { state: seeded(), route: '/virtual/leaderboards' });
    await screen.findByTestId('board-table');
    await screen.findByTestId('board-me');
    expectNoLeaks();
    expect(screen.getAllByTestId('board-row')).toHaveLength(3);
    // The two drivers whose "display name" is an e-mail or a phone are shown by their handle alone.
    expect(screen.getAllByRole('link', { name: '@rival_one' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: '@phone_name' }).length).toBeGreaterThan(0);
    fireEvent.mouseDown(screen.getByTestId('scope-friends'), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByTestId('scope-friends')).toHaveAttribute('aria-selected', 'true'));
    await screen.findByTestId('board-table');
    expectNoLeaks();
  });

  it('a driver page', async () => {
    renderSocial(<Routes><Route path="/virtual/drivers/:handle" element={<DriverPage />} /></Routes>, { state: seeded(), route: '/virtual/drivers/rival_one' });
    await screen.findByTestId('driver-header');
    expectNoLeaks();
    expect(screen.getByTestId('driver-handle').textContent).toBe('@rival_one');
    expect(screen.queryByTestId('driver-name')).not.toBeInTheDocument();
  });

  it('your own driver page', async () => {
    renderSocial(<Routes><Route path="/virtual/drivers/:handle" element={<DriverPage />} /></Routes>, { state: seeded(), route: '/virtual/drivers/lap_fan' });
    await screen.findByTestId('driver-me');
    expectNoLeaks();
  });

  it('the friends lists: friends, requests and blocked', async () => {
    renderSocial(<FriendsScreen />, { state: seeded(), route: '/virtual/friends' });
    await screen.findByTestId('list-accepted');
    expectNoLeaks();
    fireEvent.mouseDown(screen.getByTestId('tab-requests'), { button: 0, ctrlKey: false });
    await screen.findByTestId('list-incoming');
    expectNoLeaks();
    fireEvent.mouseDown(screen.getByTestId('tab-blocked'), { button: 0, ctrlKey: false });
    await screen.findByTestId('list-blocked');
    expectNoLeaks();
    expect(screen.getByTestId('list-blocked').textContent).toContain('@real_name');
  });

  it('the friend cards with their latest personal best, and the shortcut to the friends board', async () => {
    const state = seeded();
    state.v1.laps = [v1Lap({ track: monza, car: ferrari, timeMs: 99_000 })];
    renderSocial(<FriendsScreen />, { state, route: '/virtual/friends' });
    await screen.findByTestId('list-accepted');
    await screen.findByTestId('friend-activity');
    await screen.findByTestId('friend-board-shortcut');
    expectNoLeaks();
    expect(screen.getByTestId('friend-activity-time')).toHaveTextContent('1:39.000');
  });

  it('the Xpeed Companion screen: the computers, the games and the download', async () => {
    renderSocial(<XpeedSimPanel />, { state: seeded(), route: '/virtual/companion' });
    await screen.findByTestId('device');
    await screen.findAllByTestId('game-row');
    expectNoLeaks();
    expect(screen.getByTestId('device-name')).toHaveTextContent('RIG');
  });

  it('the profile settings, with the share links', async () => {
    renderSocial(<ProfileSettings />, { state: seeded(), route: '/virtual/profile' });
    await screen.findByTestId('profile-handle');
    await screen.findAllByTestId('share-row');
    expectNoLeaks();
    expect(screen.getByTestId('profile-name')).toHaveValue('Lap Fan');
  });

  it('the privacy page', async () => {
    renderSocial(<PrivacyScreen />, { state: seeded(), route: '/virtual/privacy' });
    await screen.findByTestId('visibility-picker');
    expectNoLeaks();
  });

  it('a shared lap and a shared session, with the driver and without', async () => {
    const state = seeded();
    const lap = (driverName: string | null, extra: object = {}) => stuff({
      kind: 'lap' as const, createdAt: '2026-11-13T10:00:00.000Z', expiresAt: null, driver: stuff({ handle: 'rival_one', displayName: driverName }),
      lap: stuff({ id: 'l1', game: 'lmu', track: stuff({ name: 'Monza', lengthM: 5793 }), car: stuff({ name: 'Ferrari 499P', class: null }), lapNumber: 2, timeMs: 99_000, valid: true, startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: [30_000, 40_000, 29_000], topSpeedKmh: 300 }),
      ...extra,
    });
    state.publicTokens.set('mail', lap(OTHER_EMAIL) as never);
    state.publicTokens.set('phone', lap(PHONE) as never);
    state.publicTokens.set('sess', stuff({
      kind: 'session' as const, createdAt: '2026-11-13T10:00:00.000Z', expiresAt: null, driver: stuff({ handle: 'rival_one', displayName: `${REAL_NAME} ${EMAIL}` }),
      session: stuff({ game: 'lmu', track: stuff({ name: 'Monza', lengthM: null }), car: stuff({ name: 'Ferrari', class: null }), kind: 'race', startedAt: '2026-11-10T12:00:00.000Z', endedAt: '2026-11-10T12:30:00.000Z', weather: null, airTempC: null, trackTempC: null, lapCount: 1, bestLapMs: 99_000, laps: [stuff({ id: 'l1', lapNumber: 1, timeMs: 99_000, valid: true, startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: null, topSpeedKmh: null })] }),
    }) as never);
    for (const name of ['mail', 'phone', 'sess']) {
      cleanup();
      renderSocial(<Routes><Route path="/s/:token" element={<PublicSharePage />} /></Routes>, { state, route: `/s/${name}` });
      await screen.findByTestId(name === 'sess' ? 'public-session' : 'public-lap');
      expectNoLeaks();
      expect(screen.getByTestId('driver-handle').textContent).toBe('@rival_one');
    }
  });

  it('the admin page: reports, the lap inspector and the people in them', async () => {
    const state = seeded();
    state.admin = true;
    const lapReport: AdminReport = stuff({
      id: '30000000-0000-4000-8000-000000000001', kind: 'lap' as const, status: 'open' as const, reason: 'cheating' as const, details: 'too fast', createdAt: '2026-11-12T10:00:00.000Z', decidedAt: null,
      reporter: stuff({ handle: 'sharp_eyes', displayName: EMAIL }),
      target: stuff({ lapId: '10000000-0000-4000-8000-000000000099', game: 'lmu', track: monza, car: ferrari, timeMs: 88_000, plausible: false, hidden: false, owner: stuff({ handle: 'suspect', displayName: PHONE }) }),
    });
    state.reports = [lapReport, stuff({
      id: '30000000-0000-4000-8000-000000000002', kind: 'profile' as const, status: 'open' as const, reason: 'spam' as const, details: null, createdAt: '2026-11-12T10:00:00.000Z', decidedAt: null,
      reporter: stuff({ handle: 'sharp_eyes', displayName: null }), target: stuff({ handle: 'rude_one', displayName: OTHER_EMAIL, visibility: 'public' as const, hidden: false }),
    })];
    state.adminLaps.set('10000000-0000-4000-8000-000000000099', stuff({
      lap: stuff({ id: '10000000-0000-4000-8000-000000000099', game: 'lmu', track: monza, car: ferrari, lapNumber: 1, timeMs: 88_000, valid: true, startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: null, topSpeedKmh: 300, sampleCount: 100, sizeBytes: 1, formatVersion: 2, createdAt: '2026-11-10T12:00:00.000Z', marked: false, plausible: false, plausibility: { v: 1, failed: [{ check: 'speed_range', detail: { max: 170 } }] }, hidden: false }),
      owner: stuff({ handle: 'suspect', displayName: PHONE, visibility: 'public' as const, hidden: false }), onLeaderboard: false, reports: [],
    }));
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    expectNoLeaks();
    fireEvent.click(screen.getAllByTestId('report-inspect')[0]);
    await screen.findByTestId('inspect-check');
    expectNoLeaks();
  });

  it('the report dialog and the share dialog', async () => {
    const state = seeded();
    state.shareable.laps.set('l1', stuff({ kind: 'lap' as const, createdAt: '', expiresAt: null, driver: null, lap: stuff({ id: 'l1', game: 'lmu', track: stuff({ name: 'Monza', lengthM: null }), car: stuff({ name: 'F', class: null }), lapNumber: 1, timeMs: 1, valid: true, startedAt: '', sectorsMs: null, topSpeedKmh: null }) }) as never);
    const { ShareDialog } = await import('./ShareDialog');
    const { ReportDialog } = await import('./ReportDialog');
    renderSocial(<><ShareDialog open onOpenChange={() => undefined} target={{ lapId: 'l1' }} /><ReportDialog open onOpenChange={() => undefined} targets={[{ kind: 'profile', handle: 'rival_one' }]} /></>, { state });
    await screen.findAllByTestId('share-dialog');
    expectNoLeaks();
  });
});
