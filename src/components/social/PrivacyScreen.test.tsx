import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { bytesOf } from '@/lib/sim/read-lap-file';
import { renderSocial, callsTo } from '@/test/social-render';
import { fakeSocialState } from '@/test/social-fake-server';
import { ref, v1Lap, v1Session } from '@/test/v1-fake-server';
import { PrivacyScreen } from './PrivacyScreen';

const library = vi.hoisted(() => ({ cleared: [] as string[] }));
vi.mock('@/lib/sim/library', () => ({ clearCache: async (userId: string) => { library.cleared.push(userId); } }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const SENTENCE = 'delete my racing data';
let blobs: Blob[];
let clicks: Array<{ download: string; href: string }>;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  library.cleared.length = 0;
  blobs = [];
  clicks = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ download: this.download, href: this.href });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = async (state = fakeSocialState()) => {
  const view = renderSocial(<PrivacyScreen />, { state, route: '/virtual/privacy' });
  await screen.findByTestId('visibility-picker');
  return view;
};

describe('the privacy screen: visibility', () => {
  it('shows the same three choices as the profile settings and saves a change at once with PATCH', async () => {
    const state = fakeSocialState();
    await open(state);
    expect(screen.getByTestId('visibility-public')).toBeChecked();
    fireEvent.click(screen.getByTestId('visibility-private'));
    await screen.findByTestId('visibility-saved');
    expect(callsTo(state, 'PATCH', '/profile')[0].body).toEqual({ visibility: 'private' });
    expect(screen.getByTestId('visibility-private')).toBeChecked();
  });

  it('links to the privacy policy and the terms', async () => {
    await open();
    const links = screen.getByTestId('privacy-links');
    expect(within(links).getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy');
    expect(within(links).getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', '/terms');
  });
});

describe('the privacy screen: download my data', () => {
  it('asks for the export on the click and saves the JSON as a file named xpeed-virtual-data.json', async () => {
    const state = fakeSocialState();
    state.v1.sessions = [v1Session({ track: ref('Monza'), car: ref('Ferrari') })];
    await open(state);
    expect(callsTo(state, 'GET', '/me/export')).toHaveLength(0); // nothing is downloaded by itself
    fireEvent.click(screen.getByTestId('export-button'));
    await screen.findByTestId('export-done');
    expect(callsTo(state, 'GET', '/me/export')).toHaveLength(1);
    expect(blobs).toHaveLength(1);
    expect(clicks).toEqual([{ download: 'xpeed-virtual-data.json', href: 'blob:test/1' }]);
    const document = JSON.parse(new TextDecoder().decode(await bytesOf(blobs[0])));
    expect(document).toMatchObject({ format: 'xpeed-virtual-export', version: 1, profile: { handle: 'lap_fan' } });
    expect(JSON.stringify(document)).not.toMatch(/@\w+\.\w+/); // no e-mail address anywhere in it
  });

  it('says in words when the export is rate limited and downloads nothing', async () => {
    const state = fakeSocialState();
    await open(state);
    state.failing = { status: 429, error: 'too_many_requests', retryable: true };
    fireEvent.click(screen.getByTestId('export-button'));
    expect(await screen.findByTestId('export-error')).toHaveTextContent('Too many tries in a short time.');
    expect(clicks).toHaveLength(0);
    expect(screen.getByTestId('export-button')).toBeEnabled();
  });
});

describe('the privacy screen: delete my racing data', () => {
  const openDelete = async (state = fakeSocialState()) => {
    const view = await open(state);
    fireEvent.click(screen.getByTestId('delete-open'));
    const dialog = await screen.findByTestId('delete-dialog');
    return { ...view, dialog };
  };
  const typeSentence = (value: string) => fireEvent.change(screen.getByTestId('delete-input'), { target: { value } });

  it('explains what is deleted and that the account stays, and shows the sentence to type', async () => {
    const { dialog } = await openDelete();
    expect(dialog).toHaveTextContent('Your account stays');
    expect(dialog).toHaveTextContent('erased for good');
    expect(screen.getByTestId('delete-sentence')).toHaveTextContent(SENTENCE);
    expect(screen.getByTestId('privacy-delete')).toHaveTextContent('Your Xpeed account and Real car data stay');
  });

  it('keeps the confirm button off until the sentence matches exactly', async () => {
    const state = fakeSocialState();
    await openDelete(state);
    const confirm = screen.getByTestId('delete-confirm');
    expect(confirm).toBeDisabled();
    for (const wrong of ['delete', 'delete my racing dat', 'Delete my racing data', 'DELETE MY RACING DATA', ' delete my racing data', 'delete my racing data ', 'delete  my racing data', 'delete my racing data!']) {
      typeSentence(wrong);
      expect(confirm).toBeDisabled();
    }
    typeSentence(SENTENCE);
    expect(confirm).toBeEnabled();
    typeSentence(`${SENTENCE}.`);
    expect(confirm).toBeDisabled();
    // A disabled button does nothing, even from the keyboard: submitting the form sends nothing.
    fireEvent.submit(screen.getByTestId('delete-input').closest('form')!);
    expect(callsTo(state, 'DELETE', '/me/data')).toHaveLength(0);
  });

  it('on confirmation deletes with the exact sentence, shows the success page, and clears every cache of the account', async () => {
    const state = fakeSocialState();
    state.v1.laps = [v1Lap(), v1Lap()];
    state.v1.sessions = [v1Session()];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['sim-v1', 'ana', 'overview'], { stale: 'overview of the old data' });
    client.setQueryData(['sim-v1', 'ana', 'social', 'profile'], { handle: 'lap_fan' });
    client.setQueryData(['sim-lap-file', 'ana', 'lap-1'], { big: 'samples' });
    client.setQueryData(['car-brands'], ['not of the account']);
    const view = renderSocial(<PrivacyScreen />, { state, client, route: '/virtual/privacy' });
    await screen.findByTestId('visibility-picker');
    fireEvent.click(screen.getByTestId('delete-open'));
    await screen.findByTestId('delete-dialog');
    typeSentence(SENTENCE);
    fireEvent.click(screen.getByTestId('delete-confirm'));

    const success = await screen.findByTestId('delete-success');
    expect(success).toHaveTextContent('Your racing data was deleted');
    expect(success).toHaveTextContent('2 laps, 1 sessions');
    expect(success).toHaveTextContent('Your account is still here');
    expect(within(success).getByRole('link', { name: 'Back to Overview' })).toHaveAttribute('href', '/virtual');
    expect(callsTo(state, 'DELETE', '/me/data')[0].body).toEqual({ confirm: SENTENCE });
    expect(state.deleted).not.toBeNull();

    // The cache of this account is gone: the answers read from the server, the downloaded lap files and the device's lap library.
    expect(view.client.getQueryData(['sim-v1', 'ana', 'overview'])).toBeUndefined();
    expect(view.client.getQueryData(['sim-v1', 'ana', 'social', 'profile'])).toBeUndefined();
    expect(view.client.getQueryData(['sim-lap-file', 'ana', 'lap-1'])).toBeUndefined();
    expect(library.cleared).toEqual(['ana']);
    // What is not the account's stays.
    expect(view.client.getQueryData(['car-brands'])).toEqual(['not of the account']);
    // The screen does not read the profile again (that would make a new one).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callsTo(state, 'GET', '/profile')).toHaveLength(0); // it was warm before, and nothing asked for it after
    expect(screen.queryByTestId('privacy-delete')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and the cache as it was when the server refuses', async () => {
    const state = fakeSocialState();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['sim-v1', 'ana', 'overview'], { keep: true });
    renderSocial(<PrivacyScreen />, { state, client, route: '/virtual/privacy' });
    await screen.findByTestId('visibility-picker');
    fireEvent.click(screen.getByTestId('delete-open'));
    await screen.findByTestId('delete-dialog');
    typeSentence(SENTENCE);
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(await screen.findByTestId('delete-error')).toHaveTextContent('Something went wrong on our side.');
    expect(screen.queryByTestId('delete-success')).not.toBeInTheDocument();
    expect(client.getQueryData(['sim-v1', 'ana', 'overview'])).toEqual({ keep: true });
    expect(library.cleared).toEqual([]);
    expect(screen.getByTestId('delete-confirm')).toBeEnabled(); // it can be tried again
  });

  it('forgets the sentence when the dialog is closed and opened again', async () => {
    await openDelete();
    typeSentence(SENTENCE);
    fireEvent.click(within(screen.getByTestId('delete-dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('delete-dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-open'));
    await screen.findByTestId('delete-dialog');
    expect(screen.getByTestId('delete-input')).toHaveValue('');
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
  });

  it('is translated, and still wants the sentence in English', async () => {
    await i18n.changeLanguage('pt-BR');
    await openDelete();
    expect(screen.getByTestId('delete-dialog')).toHaveTextContent('Sua conta fica');
    expect(screen.getByTestId('delete-dialog')).toHaveTextContent('em inglês');
    expect(screen.getByTestId('delete-sentence')).toHaveTextContent(SENTENCE);
  });
});

describe('the privacy page as a settings page', () => {
  it('has a block for who can see you, one for your data and a danger zone for the deletion, apart from each other', async () => {
    await open();
    const visibility = screen.getByTestId('privacy-visibility');
    const download = screen.getByTestId('privacy-download');
    const danger = screen.getByTestId('privacy-delete');
    expect(within(visibility).getByTestId('visibility-picker')).toBeInTheDocument();
    expect(within(download).getByTestId('export-button')).toBeInTheDocument();
    expect(within(danger).getByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
    expect(within(danger).getByTestId('delete-open')).toBeInTheDocument();
    // The download is not in the danger zone, and the deletion is not next to the download.
    expect(within(danger).queryByTestId('export-button')).not.toBeInTheDocument();
    expect(within(download).queryByTestId('delete-open')).not.toBeInTheDocument();
    expect(danger).toHaveTextContent('cannot be undone');
  });

  it('shows under each choice what it lets others see, so the choice can be made knowing what it does', async () => {
    await open();
    const rows = (option: string) => [...screen.getByTestId(`visibility-shows-${option}`).querySelectorAll('li')].map((row) => `${row.textContent?.replace(/\s+/g, ' ').trim()}`);
    expect(rows('private')).toEqual(['Public leaderboards: not shown', 'Friends leaderboards: not shown', 'Your driver page: not shown', 'Found by your handle: not shown']);
    expect(rows('friends')[0]).toBe('Public leaderboards: not shown');
    expect(rows('friends')[1]).toBe('Friends leaderboards: shown');
    expect(rows('public').every((text) => text.endsWith(': shown'))).toBe(true);
  });

  it('keeps the deletion behind the dialog and the exact sentence on this layout too', async () => {
    const state = fakeSocialState();
    await open(state);
    fireEvent.click(screen.getByTestId('delete-open'));
    const dialog = await screen.findByTestId('delete-dialog');
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
    fireEvent.change(screen.getByTestId('delete-input'), { target: { value: SENTENCE } });
    expect(screen.getByTestId('delete-confirm')).toBeEnabled();
    expect(callsTo(state, 'DELETE', '/me/data')).toHaveLength(0);
    expect(dialog).toHaveTextContent('Your account stays');
  });

  it('exports VisibilitySection for Settings: the same choice, saved at once, with the link to the data page', async () => {
    const { VisibilitySection } = await import('./PrivacyScreen');
    const state = fakeSocialState();
    renderSocial(<VisibilitySection withDataLink />, { state, route: '/settings' });
    await screen.findByTestId('visibility-picker');
    expect(screen.getByRole('link', { name: 'Download or delete my racing data' })).toHaveAttribute('href', '/virtual/privacy');
    fireEvent.click(screen.getByTestId('visibility-friends'));
    await screen.findByTestId('visibility-saved');
    expect(callsTo(state, 'PATCH', '/profile')[0].body).toEqual({ visibility: 'friends' });
  });

  it('says it in Portuguese: the danger zone and the preview rows', async () => {
    await i18n.changeLanguage('pt-BR');
    await open();
    expect(screen.getByTestId('privacy-delete')).toHaveTextContent('Zona de perigo');
    expect(screen.getByTestId('visibility-shows-private')).toHaveTextContent('não mostrado');
  });
});
