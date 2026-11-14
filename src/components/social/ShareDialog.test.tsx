import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSocial, callsTo } from '@/test/social-render';
import { fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { ref, v1Lap, v1Session } from '@/test/v1-fake-server';
import { SessionPage } from '@/components/sim/SessionPage';
import { ShareButton, ShareDialog } from './ShareDialog';

vi.mock('@/components/sim/SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock);
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const LAP_ID = '10000000-0000-4000-8000-000000000042';
const publicLap = { kind: 'lap' as const, createdAt: '2026-11-13T10:00:00.000Z', expiresAt: null, driver: null, lap: { id: LAP_ID, game: 'lmu', track: { name: 'Monza', lengthM: 5793 }, car: { name: 'Ferrari 499P', class: null }, lapNumber: 4, timeMs: 99_500, valid: true, startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: null, topSpeedKmh: null } };

function seeded(): FakeSocialState {
  const state = fakeSocialState();
  state.shareable.laps.set(LAP_ID, publicLap);
  return state;
}

function Harness({ target = { lapId: LAP_ID } as { lapId: string } | { sessionId: string } }) {
  return <ShareButton target={target} />;
}
const openDialog = async () => {
  fireEvent.click(screen.getByTestId('share-button'));
  return screen.findByTestId('share-dialog');
};
let clipboard: { writeText: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  await i18n.changeLanguage('en');
  clipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the share dialog', () => {
  it('creates a link to the lap that never expires, and shows its address once with a copy button', async () => {
    const state = seeded();
    renderSocial(<Harness />, { state });
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('Share this lap');
    expect(dialog).toHaveTextContent('Anyone who has the link can see it');
    fireEvent.click(within(dialog).getByTestId('share-create'));
    const url = (await within(dialog).findByTestId('share-url')) as HTMLInputElement;

    const post = callsTo(state, 'POST', '/shares')[0];
    expect(post.body).toEqual({ lapId: LAP_ID });
    expect(post.authorization).toBe('Bearer token');
    expect(url.value).toMatch(/\/s\/tok/);
    expect(url).toHaveAttribute('readonly');
    expect(within(dialog).getByTestId('share-once')).toHaveTextContent('only time the link is shown');

    fireEvent.click(within(dialog).getByTestId('share-copy'));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(url.value));
    await waitFor(() => expect(within(dialog).getByTestId('share-copy')).toHaveTextContent('Copied'));
  });

  it('sends the end date when 7 or 30 days is chosen', async () => {
    const state = seeded();
    renderSocial(<Harness />, { state });
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByTestId('share-expiry'), { target: { value: '7' } });
    fireEvent.click(within(dialog).getByTestId('share-create'));
    await within(dialog).findByTestId('share-url');
    expect(callsTo(state, 'POST', '/shares')[0].body).toEqual({ lapId: LAP_ID, expiresInDays: 7 });
  });

  it('shares a whole session by its id', async () => {
    const state = seeded();
    const sessionId = '30000000-0000-4000-8000-000000000001';
    state.shareable.sessions.set(sessionId, { ...publicLap, kind: 'session', session: { game: 'lmu', track: { name: 'Monza', lengthM: null }, car: { name: 'Ferrari', class: null }, kind: 'race', startedAt: '', endedAt: '', weather: null, airTempC: null, trackTempC: null, lapCount: 0, bestLapMs: null, laps: [] } } as never);
    renderSocial(<Harness target={{ sessionId }} />, { state });
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('Share this session');
    fireEvent.click(within(dialog).getByTestId('share-create'));
    await within(dialog).findByTestId('share-url');
    expect(callsTo(state, 'POST', '/shares')[0].body).toEqual({ sessionId });
  });

  it('never shows the address again: closing and reopening lists the link without its token, and it can be revoked', async () => {
    const state = seeded();
    renderSocial(<Harness />, { state });
    let dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId('share-create'));
    const first = ((await within(dialog).findByTestId('share-url')) as HTMLInputElement).value;
    expect(first).toContain('/s/');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('share-dialog')).not.toBeInTheDocument());
    dialog = await openDialog();
    expect(within(dialog).queryByTestId('share-url')).not.toBeInTheDocument();
    expect(dialog.textContent).not.toContain('/s/');
    expect(dialog.textContent).not.toContain(first);
    const rows = await within(dialog).findAllByTestId('share-row');
    expect(rows).toHaveLength(1);
    // The server never lists a token either.
    expect(JSON.stringify(state.shares)).not.toContain('tok');

    fireEvent.click(within(rows[0]).getByTestId('share-revoke'));
    await waitFor(() => expect(within(dialog).queryAllByTestId('share-row')).toHaveLength(0));
    expect(callsTo(state, 'DELETE', `/shares/${state.shares[0].id}`)).toHaveLength(1);
    expect(state.shares[0].active).toBe(false);
  });

  it('lists only the live links to this lap, not those of other laps or revoked ones', async () => {
    const state = seeded();
    state.shares = [
      { id: '20000000-0000-4000-8000-0000000000a1', kind: 'lap', lapId: LAP_ID, sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true },
      { id: '20000000-0000-4000-8000-0000000000a2', kind: 'lap', lapId: 'other', sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true },
      { id: '20000000-0000-4000-8000-0000000000a3', kind: 'lap', lapId: LAP_ID, sessionId: null, createdAt: '2026-11-01T10:00:00.000Z', expiresAt: null, revokedAt: '2026-11-02T10:00:00.000Z', active: false },
    ];
    renderSocial(<Harness />, { state });
    const dialog = await openDialog();
    expect(await within(dialog).findAllByTestId('share-row')).toHaveLength(1);
  });

  it('says in words when there are too many live links', async () => {
    const state = seeded();
    renderSocial(<Harness />, { state });
    const dialog = await openDialog();
    state.shares = Array.from({ length: 100 }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, kind: 'lap' as const, lapId: `l${i}`, sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true }));
    fireEvent.click(within(dialog).getByTestId('share-create'));
    expect(await within(dialog).findByTestId('share-error')).toHaveTextContent('You have 100 active links.');
  });

  it('says so when the clipboard is not available', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    renderSocial(<Harness />, { state: seeded() });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId('share-create'));
    await within(dialog).findByTestId('share-url');
    fireEvent.click(within(dialog).getByTestId('share-copy'));
    expect(await within(dialog).findByText('Could not copy. Select the link and copy it.')).toBeInTheDocument();
  });

  it('can be opened on its own with a custom title', async () => {
    renderSocial(<ShareDialog open onOpenChange={() => undefined} target={{ lapId: LAP_ID }} title="Share lap 4" />, { state: seeded() });
    expect(await screen.findByTestId('share-dialog')).toHaveTextContent('Share lap 4');
  });
});

describe('sharing from the session page', () => {
  let idb: FakeIdb;
  beforeEach(() => {
    idb = installFakeIndexedDb();
  });
  afterEach(() => idb.uninstall());

  it('puts a Share session button on the session and a Share lap button on every lap, each opening the dialog for its own target', async () => {
    const monza = ref('Monza');
    const ferrari = ref('Ferrari 499P');
    const session = v1Session({ track: monza, car: ferrari, lapCount: 2, bestLapMs: 99_500 });
    const laps = [
      v1Lap({ sessionId: session.id, track: monza, car: ferrari, lapNumber: 1, timeMs: 100_000 }),
      v1Lap({ sessionId: session.id, track: monza, car: ferrari, lapNumber: 2, timeMs: 99_500 }),
    ];
    const state = fakeSocialState();
    state.v1.sessions = [session];
    state.v1.laps = laps;
    state.shareable.laps.set(laps[1].id, publicLap);
    state.shareable.sessions.set(session.id, { ...publicLap, kind: 'session' } as never);
    renderSocial(
      <Routes><Route path="/virtual/sessions/:id" element={<SessionPage />} /></Routes>,
      { state, route: `/virtual/sessions/${session.id}` },
    );
    await screen.findByTestId('session-header');
    expect(screen.getByRole('button', { name: 'Share session' })).toBeInTheDocument();
    expect(screen.getAllByTestId('session-lap')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Share lap 2' }));
    const dialog = await screen.findByTestId('share-dialog');
    expect(dialog).toHaveTextContent('Share this lap');
    fireEvent.click(within(dialog).getByTestId('share-create'));
    await within(dialog).findByTestId('share-url');
    expect(callsTo(state, 'POST', '/shares')[0].body).toEqual({ lapId: laps[1].id });
  });
});
