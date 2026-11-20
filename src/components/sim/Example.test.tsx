import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { toast } from '@/hooks/use-toast';
import { deleteAccountTrack } from '@/lib/sim/account-tracks';
import { REFUSAL_GAP_MS, enterDemo, isDemoMode, leaveDemo } from '@/lib/sim/demo/mode';
import { V1Error, v1Delete, v1Get, v1Send } from '@/lib/sim/v1-client';
import { renderSim } from '@/test/sim-render';
import { fakeV1State } from '@/test/v1-fake-server';
import { dashboardState, oneInvalidLapState } from '@/test/dashboard-fixture';
import SimAppPage from '@/pages/SimAppPage';
import SimCarsPage from '@/pages/SimCarsPage';
import SimOverviewPage from '@/pages/SimOverviewPage';
import SimSessionPage from '@/pages/SimSessionPage';
import SimSessionsPage from '@/pages/SimSessionsPage';
import SimTrackPage from '@/pages/SimTrackPage';
import SimTracksPage from '@/pages/SimTracksPage';
import SocialDriverPage from '@/pages/SocialDriverPage';
import SocialFriendsPage from '@/pages/SocialFriendsPage';
import SocialLeaderboardsPage from '@/pages/SocialLeaderboardsPage';
import SocialPrivacyPage from '@/pages/SocialPrivacyPage';
import SocialProfilePage from '@/pages/SocialProfilePage';
import { CompanionStatus } from './CompanionStatus';
import { SimOverview } from './SimOverview';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/hooks/use-toast', async (original) => ({ ...(await original<typeof import('@/hooks/use-toast')>()), toast: vi.fn() }));
// The app shell around a page (menu, chat, install prompt...) is not what is tested here: the shell's own banner slot is.
vi.mock('@/contexts/ModesContext', () => ({ useModes: () => ({ mode: 'virtual', modes: ['real', 'virtual'], virtualAvailable: true }) }));
vi.mock('@/contexts/PageRefreshContext', () => ({ usePageRefresh: () => ({ refresh: async () => undefined }) }));
vi.mock('@/components/AppSidebar', () => ({ AppSidebar: () => null }));
vi.mock('@/components/ChatBubble', () => ({ ChatBubble: () => null }));
vi.mock('@/components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('@/components/AppUpdateBanner', () => ({ AppUpdateBanner: () => null }));
vi.mock('@/components/MobileTabBar', () => ({ MobileTabBar: () => null }));
vi.mock('@/components/trip/NewCarDialog', () => ({ NewCarDialog: () => null }));
vi.mock('@/components/BrandLockup', () => ({ BrandLockup: () => null }));
vi.mock('@/components/PullToRefresh', () => ({ PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/header/HeaderControls', () => ({ HeaderControls: () => null }));
vi.mock('@/components/ModeSwitch', () => ({ ModeSwitch: () => null }));
// The real charts need a layout engine.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  LineChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  AreaChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  Bar: () => null, Line: () => null, Area: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  leaveDemo();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const SESSION_ID = '00000003-0000-4000-8000-000000000001';
const v1Calls = () => (globalThis.fetch as Mock).mock.calls.filter(([input]) => String(input).includes('/api/sim/v1'));

/** An account with nothing in it, the Overview open. */
const emptyOverview = (route = '/virtual') => renderSim(<SimOverviewPage />, { state: fakeV1State(), route });

describe('the "See an example" button', () => {
  it('is on the Overview of an account with no laps, and switches the example on', async () => {
    emptyOverview();
    const button = await screen.findByRole('button', { name: 'See an example' });
    expect(screen.queryByTestId('example-banner')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(isDemoMode()).toBe(true);
    expect(sessionStorage.getItem('xpeed.virtual.example')).toBe('1');
    await screen.findByTestId('overview-dashboard');
    // The invitation is gone, the banner is up.
    expect(screen.queryByRole('button', { name: 'See an example' })).not.toBeInTheDocument();
    expect(screen.getByTestId('example-banner')).toHaveTextContent('You are looking at an example. Your own laps appear here once Xpeed Companion sends them.');
  });

  it('is on the Overview of an account whose laps are all flagged not valid', async () => {
    renderSim(<SimOverviewPage />, { state: oneInvalidLapState(), route: '/virtual' });
    expect(await screen.findByRole('button', { name: 'See an example' })).toBeInTheDocument();
  });

  it('is not there when the account has valid laps', async () => {
    renderSim(<SimOverviewPage />, { state: dashboardState(), route: '/virtual' });
    await screen.findByTestId('overview-dashboard');
    expect(screen.queryByRole('button', { name: 'See an example' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('example-invite')).not.toBeInTheDocument();
  });
});

describe('the banner', () => {
  it('is not shown while the example is off', async () => {
    renderSim(<SimSessionsPage />, { state: dashboardState(), route: '/virtual/sessions' });
    await screen.findByRole('heading', { level: 2, name: 'Sessions' });
    expect(screen.queryByTestId('example-banner')).not.toBeInTheDocument();
  });

  const pages: Array<[string, () => ReactNode, string]> = [
    ['Overview', () => <SimOverviewPage />, '/virtual'],
    ['Sessions', () => <SimSessionsPage />, '/virtual/sessions'],
    ['Tracks', () => <SimTracksPage />, '/virtual/tracks'],
    ['Game cars', () => <SimCarsPage />, '/virtual/cars'],
    ['Leaderboards', () => <SocialLeaderboardsPage />, '/virtual/leaderboards'],
    ['Friends', () => <SocialFriendsPage />, '/virtual/friends'],
    ['Profile', () => <SocialProfilePage />, '/virtual/profile'],
    ['Privacy', () => <SocialPrivacyPage />, '/virtual/privacy'],
    ['Companion', () => <SimAppPage />, '/virtual/companion'],
  ];
  it.each(pages)('is on the %s page while the example is on, with the way out', async (_name, page, route) => {
    enterDemo();
    renderSim(page(), { state: fakeV1State(), route });
    const banner = await screen.findByTestId('example-banner');
    expect(within(banner).getByRole('button', { name: 'Leave the example' })).toBeInTheDocument();
  });

  it('is on the page of one session, one track and one driver too', async () => {
    enterDemo();
    const wrapped = (path: string, page: ReactNode) => (node: ReactNode) => <Routes><Route path={path} element={node} /></Routes>;
    renderSim(<SimSessionPage />, { state: fakeV1State(), route: `/virtual/sessions/${SESSION_ID}`, wrap: wrapped('/virtual/sessions/:id', null) });
    expect(await screen.findByTestId('example-banner')).toBeInTheDocument();
    cleanup();
    renderSim(<SimTrackPage />, { state: fakeV1State(), route: '/virtual/tracks/00000001-0000-4000-8000-000000000001', wrap: wrapped('/virtual/tracks/:id', null) });
    expect(await screen.findByTestId('example-banner')).toBeInTheDocument();
    cleanup();
    renderSim(<SocialDriverPage />, { state: fakeV1State(), route: '/virtual/drivers/ana', wrap: wrapped('/virtual/drivers/:handle', null) });
    expect(await screen.findByTestId('example-banner')).toBeInTheDocument();
  });

  it('is in every Virtual page file (each one is drawn inside the app shell that carries it)', async () => {
    const files = import.meta.glob('/src/pages/{Sim,Social}*Page.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const shown = Object.entries(files).filter(([name]) => !/SimConnectPage|SocialSharePage|SimLivePage|SimPage\.tsx$/.test(name));
    expect(shown.length).toBeGreaterThanOrEqual(12);
    for (const [name, source] of shown) expect(source, name).toContain('<AppLayout');
  });
});

describe('reads in the example', () => {
  it('come from the made-up account in the browser and never from /api/sim/v1', async () => {
    emptyOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'See an example' }));
    const realReads = v1Calls().length;
    await screen.findByTestId('overview-dashboard');
    // The overview's pieces are alive: the tiles, the latest sessions and the personal bests of the made-up driver.
    expect(screen.getByTestId('overview-dashboard')).toHaveTextContent(/Monza|Imola|Interlagos|Spa/);
    expect(v1Calls()).toHaveLength(realReads);
    cleanup();
    renderSim(<SimSessionsPage />, { state: fakeV1State(), route: '/virtual/sessions' });
    await waitFor(() => expect(screen.getAllByText(/Monza|Imola|Interlagos|Spa-Francorchamps/).length).toBeGreaterThan(0));
    // Not one call at all on another page (the new render has a fresh fetch to count on).
    expect(v1Calls()).toHaveLength(0);
  });

  it('are cached under the example account of their own, never under the real one', async () => {
    const view = emptyOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'See an example' }));
    await screen.findByTestId('overview-dashboard');
    const keys = view.client.getQueryCache().getAll().map((query) => query.queryKey).filter((key) => key[0] === 'sim-v1');
    expect(keys.filter((key) => key[1] === 'ana')).toHaveLength(0);
    expect(keys.filter((key) => key[1] === 'example').length).toBeGreaterThan(0);
  });

  it('show no computer: the header chip says Example, and the Companion page and the social pages are left out politely', async () => {
    enterDemo();
    renderSim(<CompanionStatus />, { state: fakeV1State(), route: '/virtual' });
    expect(await screen.findByTestId('companion-status-example')).toHaveTextContent('Example');
    expect(screen.queryByTestId('companion-status')).not.toBeInTheDocument();
    cleanup();
    renderSim(<SocialFriendsPage />, { state: fakeV1State(), route: '/virtual/friends' });
    const panel = await screen.findByTestId('example-not-part');
    expect(panel).toHaveTextContent('Not part of the example');
    expect(v1Calls().filter(([input]) => String(input).includes('/friends'))).toHaveLength(0);
    cleanup();
    renderSim(<SimAppPage />, { state: fakeV1State(), route: '/virtual/companion' });
    expect(await screen.findByTestId('example-not-part')).toBeInTheDocument();
  });

  it('read the shape of the circuits and the laps from the browser too', async () => {
    emptyOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'See an example' }));
    await screen.findByTestId('overview-dashboard');
    const sessions = await v1Get<{ sessions: Array<{ id: string }>; nextCursor: string | null }>('/sessions');
    const laps = await v1Get<{ laps: Array<{ id: string }> }>('/laps', { session: sessions.sessions[0].id });
    expect(laps.laps.length).toBeGreaterThan(5);
    const layouts = await (await import('@/lib/sim/account-tracks')).listAccountTracks();
    expect(layouts?.map((track) => track.trackName).sort()).toEqual(['Imola', 'Interlagos', 'Monza', 'Spa-Francorchamps']);
    expect(globalThis.fetch as Mock).not.toHaveBeenCalledWith(expect.stringContaining('/api/sim/tracks'), expect.anything());
  });
});

describe('writes in the example', () => {
  it('are refused with a friendly note and never reach the server', async () => {
    emptyOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'See an example' }));
    await screen.findByTestId('overview-dashboard');
    const requests = v1Calls().length;

    await expect(v1Send('POST', '/shares', { lapId: 'x' })).rejects.toMatchObject({ code: 'demo_readonly' });
    await expect(v1Send('PATCH', '/profile', { displayName: 'Someone' })).rejects.toBeInstanceOf(V1Error);
    await expect(v1Send('POST', '/reports', { reason: 'spam' })).rejects.toBeInstanceOf(V1Error);
    await expect(v1Delete('/laps/00000004-0000-4000-8000-000000000001')).rejects.toMatchObject({ status: 403, code: 'demo_readonly', retryable: false });
    expect(await deleteAccountTrack('example-layout-01')).toBe(false);

    // One note for the whole burst, not one per call.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not available in the example' }));
    // A write a little later gets its own note.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + REFUSAL_GAP_MS + 1 });
    await expect(v1Send('POST', '/shares', {})).rejects.toBeInstanceOf(V1Error);
    expect(toast).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    // No request was made for any of them.
    expect(v1Calls()).toHaveLength(requests);
    expect((globalThis.fetch as Mock).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0);
  });
});

describe('leaving the example', () => {
  it('returns to the real account at once: banner gone, the example forgotten, the real reads back, the Overview address', async () => {
    // Opened on a page that only exists in the example (one of its sessions): leaving goes to the Overview.
    const view = emptyOverview('/virtual/sessions/some-example-session');
    fireEvent.click(await screen.findByRole('button', { name: 'See an example' }));
    await screen.findByTestId('overview-dashboard');
    expect(screen.getByTestId('example-banner')).toBeInTheDocument();
    const seen = v1Calls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Leave the example' }));

    expect(isDemoMode()).toBe(false);
    expect(sessionStorage.getItem('xpeed.virtual.example')).toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent('/virtual');
    await waitFor(() => expect(screen.queryByTestId('example-banner')).not.toBeInTheDocument());
    // Everything read in the example is dropped from the cache.
    expect(view.client.getQueryCache().getAll().filter((query) => query.queryKey[0] === 'sim-v1' && query.queryKey[1] === 'example')).toHaveLength(0);
    // The real account is read again (the empty overview), over the network, and its invitation is back.
    expect(await screen.findByRole('button', { name: 'See an example' })).toBeInTheDocument();
    expect(v1Calls().length).toBeGreaterThan(seen);
  });
});

describe('when sessionStorage cannot be used', () => {
  it('the example still switches on and off (it is just not kept for the tab)', async () => {
    const broken = () => { throw new DOMException('blocked', 'SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(broken);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(broken);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(broken);
    emptyOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'See an example' }));
    expect(isDemoMode()).toBe(true);
    await screen.findByTestId('overview-dashboard');
    expect(screen.getByTestId('example-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave the example' }));
    expect(isDemoMode()).toBe(false);
    expect(await screen.findByRole('button', { name: 'See an example' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('the Overview with the example off', () => {
  it('still reads the real account from the server', async () => {
    renderSim(<SimOverview />, { state: dashboardState(), route: '/virtual' });
    await screen.findByTestId('overview-dashboard');
    expect(v1Calls().length).toBeGreaterThan(0);
  });
});
