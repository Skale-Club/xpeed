import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import CompanionPage from './CompanionPage';

const latest = {
  version: '0.5.0', build: 'abc1234', downloadUrl: 'https://xpeed.test/api/companion/download', sha256: 'f'.repeat(64),
  size: 3145728, releasedAt: '2026-11-13T12:00:00Z', minVersion: '0.4.0', signed: false,
};
const answer = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(body) } as Response);
const fetchMock = vi.fn();
/** Lets a finished (or failed) request reach the page. */
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 30)));

const open = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/companion']}><CompanionPage /></MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(async () => {
  fetchMock.mockReset().mockImplementation(() => answer(latest));
  vi.stubGlobal('fetch', fetchMock);
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the public Companion page', () => {
  it('says what it is and points the big button at the stable download link, before and after the version loads', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'Xpeed Companion' })).toBeInTheDocument();
    expect(screen.getByText(/small Windows app that sends every lap of your racing game/)).toBeInTheDocument();
    const button = screen.getByRole('link', { name: 'Download for Windows' });
    expect(button).toHaveAttribute('href', '/api/companion/download');
    await screen.findByText(/Version 0\.5\.0/);
    expect(screen.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', '/api/companion/download');
    expect(fetchMock).toHaveBeenCalledWith('/api/companion/latest', expect.anything());
  });

  it('shows the version, size and date from /api/companion/latest, and never a checksum', async () => {
    open();
    await screen.findByText(/Version 0\.5\.0/);
    expect(screen.getByTestId('companion-meta')).toHaveTextContent('Version 0.5.0 · 3.0 MB · Nov 13, 2026');
    expect(screen.queryByTestId('companion-checksum')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/checksum|SHA-?256|f{64}/i);
  });

  it('shows the Windows SmartScreen note while the build is unsigned', async () => {
    open();
    const note = await screen.findByTestId('companion-smartscreen');
    expect(note).toHaveTextContent('More info, then Run anyway');
    expect(note).not.toHaveTextContent(/checksum/i);
  });

  it('hides the SmartScreen note once the build is signed', async () => {
    fetchMock.mockImplementation(() => answer({ ...latest, signed: true }));
    open();
    await screen.findByText(/Version 0\.5\.0/);
    expect(screen.queryByTestId('companion-smartscreen')).not.toBeInTheDocument();
  });

  it('still offers the download when the version cannot be read, with no checksum and no SmartScreen note', async () => {
    fetchMock.mockImplementation(() => answer({ error: 'unavailable', retryable: true }, false));
    open();
    await settle();
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.getByTestId('companion-meta')).toHaveTextContent('Windows 10 or 11. Free.');
    expect(screen.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', '/api/companion/download');
    expect(screen.queryByTestId('companion-checksum')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-smartscreen')).not.toBeInTheDocument();
  });

  it('ignores an answer that is not a release', async () => {
    fetchMock.mockImplementation(() => answer({ hello: 'world' }));
    open();
    await settle();
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.getByTestId('companion-meta')).toHaveTextContent('Windows 10 or 11. Free.');
    expect(screen.queryByTestId('companion-smartscreen')).not.toBeInTheDocument();
  });

  it('explains the three steps, including the verification code', async () => {
    open();
    expect(screen.getByText('Install')).toBeInTheDocument();
    expect(screen.getByText('Open it and connect')).toBeInTheDocument();
    expect(screen.getByText('Drive and see your laps')).toBeInTheDocument();
    expect(screen.getByText(/Click Connect to your account/)).toHaveTextContent('4-letter verification code');
  });

  it('lists Assetto Corsa and Automobilista 2 as certified and the other games as beta', () => {
    open();
    const certified = within(screen.getByTestId('companion-certified')).getAllByRole('listitem').map((item) => item.textContent);
    expect(certified).toEqual(['Assetto Corsa', 'Automobilista 2']);
    const beta = within(screen.getByTestId('companion-beta')).getAllByRole('listitem').map((item) => item.textContent);
    expect(beta).toEqual(['Le Mans Ultimate', 'Assetto Corsa Competizione', 'Assetto Corsa EVO', 'F1 25', 'Wreckfest 2', 'iRacing', 'RaceRoom', 'rFactor', 'Forza']);
  });

  it('has the FAQ (what is sent, disconnect, files, remove) and a privacy line', () => {
    open();
    for (const question of ['What is sent?', 'How do I disconnect?', 'Where are the files kept?', 'How do I remove it?']) {
      expect(screen.getByText(question)).toBeInTheDocument();
    }
    expect(screen.getByText(/Privacy: Xpeed Companion reads only the data/)).toBeInTheDocument();
  });

  it('never shows the old internal name, in any language', async () => {
    for (const language of ['en', 'pt-BR', 'es-ES']) {
      await i18n.changeLanguage(language);
      const { unmount } = open();
      await screen.findByText(/0\.5\.0/);
      expect(document.body.textContent).not.toMatch(/\bsim\b/i);
      unmount();
    }
  });

  it('speaks Portuguese and Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    const first = open();
    expect(screen.getByRole('link', { name: 'Baixar para Windows' })).toHaveAttribute('href', '/api/companion/download');
    expect(await screen.findByTestId('companion-smartscreen')).toHaveTextContent('Executar assim mesmo');
    first.unmount();
    await i18n.changeLanguage('es-ES');
    open();
    expect(screen.getByRole('link', { name: 'Descargar para Windows' })).toHaveAttribute('href', '/api/companion/download');
    expect(await screen.findByTestId('companion-smartscreen')).toHaveTextContent('Ejecutar de todas formas');
  });
});
