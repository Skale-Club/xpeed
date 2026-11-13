import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import en from '@/locales/en.json';
import ptBR from '@/locales/pt-BR.json';
import esES from '@/locales/es-ES.json';
import PrivacyPage from './PrivacyPage';
import TermsPage from './TermsPage';

// No AuthProvider, no QueryClientProvider: the legal pages are public and need nothing but the router and i18n.
const pages = { privacy: PrivacyPage, terms: TermsPage } as const;
const open = (doc: 'privacy' | 'terms') => {
  const Page = pages[doc];
  return render(<MemoryRouter initialEntries={[`/${doc}`]}><Page /></MemoryRouter>);
};
const LANGUAGES = ['en', 'pt-BR', 'es-ES'] as const;

beforeEach(async () => {
  vi.unstubAllEnvs();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('the public legal pages', () => {
  it.each(['privacy', 'terms'] as const)('%s renders without sign-in, with the date and an index that points at real sections', (doc) => {
    open(doc);
    expect(screen.getByRole('heading', { level: 1, name: doc === 'privacy' ? 'Privacy Policy' : 'Terms of Use' })).toBeInTheDocument();
    expect(screen.getByTestId('legal-updated')).toHaveTextContent('Last updated: November 13, 2026');
    expect(screen.getByTestId('legal-updated').querySelector('time')).toHaveAttribute('datetime', '2026-11-13');
    const links = within(screen.getByTestId('legal-index')).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const link of links) {
      const id = link.getAttribute('href')!.slice(1);
      expect(document.getElementById(id), `section ${id}`).not.toBeNull();
    }
    expect(links.at(-1)).toHaveAttribute('href', '#contact');
  });

  it('privacy states the facts of how Xpeed behaves', () => {
    open('privacy');
    const text = document.body.textContent ?? '';
    for (const fact of [
      'Your profile is public by default',
      'friends only or private',
      'never shown',
      'until you revoke it or it expires',
      'older than 90 days',
      '10 samples per second',
      'It never sends: your Windows user name',
      'device key in diagnostics',
      'protected by Windows',
      'We do not sell data and we show no advertising',
      'OpenRouter',
      'Google Fonts',
      'NHTSA vPIC',
      'GitHub',
      'under 13',
      'LGPD',
      'GDPR',
    ]) expect(text, fact).toContain(fact);
    expect(screen.getAllByRole('link', { name: 'Privacy settings' })[0]).toHaveAttribute('href', '/virtual/privacy');
  });

  it('terms cover the rules, the no-warranty hint wording and the Companion updates', () => {
    open('terms');
    const text = document.body.textContent ?? '';
    for (const fact of [
      'impersonates another person',
      'Laps are checked',
      'left out of the rankings',
      'hints from data, not a diagnosis',
      'as is',
      'turn automatic updates off',
      'the country where the service operator is established',
    ]) expect(text, fact).toContain(fact);
    for (const link of screen.getAllByRole('link', { name: 'Privacy Policy' })) expect(link).toHaveAttribute('href', '/privacy');
  });

  it('shows the e-mail as selectable text and a mailto link when VITE_CONTACT_EMAIL is set', () => {
    vi.stubEnv('VITE_CONTACT_EMAIL', 'privacy@example.org');
    open('privacy');
    const line = screen.getByTestId('legal-contact-email');
    expect(line).toHaveTextContent('E-mail: privacy@example.org');
    expect(within(line).getByRole('link', { name: 'privacy@example.org' })).toHaveAttribute('href', 'mailto:privacy@example.org');
    expect(screen.queryByTestId('legal-contact-fallback')).not.toBeInTheDocument();
  });

  it.each(['', '   '])('points at the privacy settings page when VITE_CONTACT_EMAIL is empty (%j)', (value) => {
    vi.stubEnv('VITE_CONTACT_EMAIL', value);
    open('terms');
    const line = screen.getByTestId('legal-contact-fallback');
    expect(line).toHaveTextContent('does not publish an e-mail address yet');
    expect(within(line).getByRole('link', { name: 'Privacy settings' })).toHaveAttribute('href', '/virtual/privacy');
    expect(screen.queryByTestId('legal-contact-email')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('has the fallback contact line in the three languages when the e-mail is not set', async () => {
    for (const language of LANGUAGES) {
      await i18n.changeLanguage(language);
      const { unmount } = open('privacy');
      expect(screen.getByTestId('legal-contact-fallback').textContent).toBe(
        `${({ en, 'pt-BR': ptBR, 'es-ES': esES })[language].legal.contact.without} ${({ en, 'pt-BR': ptBR, 'es-ES': esES })[language].legal.links.settings}`,
      );
      unmount();
    }
  });

  it('never shows the old internal name, in any language', async () => {
    vi.stubEnv('VITE_CONTACT_EMAIL', 'privacy@example.org');
    for (const language of LANGUAGES) {
      await i18n.changeLanguage(language);
      for (const doc of ['privacy', 'terms'] as const) {
        const { unmount } = open(doc);
        expect(document.body.textContent, `${doc} ${language}`).not.toMatch(/\bsim\b/i);
        unmount();
      }
    }
  });

  it('speaks Portuguese and Spanish, with the date in each language', async () => {
    await i18n.changeLanguage('pt-BR');
    let view = open('privacy');
    expect(screen.getByRole('heading', { level: 1, name: 'Política de Privacidade' })).toBeInTheDocument();
    expect(screen.getByTestId('legal-updated')).toHaveTextContent('Última atualização: 13 de novembro de 2026');
    expect(document.body.textContent).toContain('Seu perfil é público por padrão');
    view.unmount();
    await i18n.changeLanguage('es-ES');
    view = open('terms');
    expect(screen.getByRole('heading', { level: 1, name: 'Términos de Uso' })).toBeInTheDocument();
    expect(screen.getByTestId('legal-updated')).toHaveTextContent('Última actualización: 13 de noviembre de 2026');
    view.unmount();
  });
});

describe('the legal texts in the locale files', () => {
  const locales = { en, 'pt-BR': ptBR, 'es-ES': esES };
  const shape = (node: unknown): unknown =>
    Array.isArray(node) ? node.map(() => 'string')
      : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shape(v)]))
        : 'string';
  const words = (node: unknown): number =>
    typeof node === 'string' ? node.split(/\s+/).filter(Boolean).length
      : Array.isArray(node) ? node.reduce((sum: number, v) => sum + words(v), 0)
        : node && typeof node === 'object' ? Object.values(node).reduce((sum: number, v) => sum + words(v), 0) : 0;

  it('have the same keys and the same number of paragraphs and list items in every language', () => {
    expect(shape(ptBR.legal)).toEqual(shape(en.legal));
    expect(shape(esES.legal)).toEqual(shape(en.legal));
  });

  it.each(LANGUAGES)('keep each document under 900 words in %s', (language) => {
    const { legal } = locales[language];
    expect(words(legal.privacy)).toBeLessThan(900);
    expect(words(legal.terms)).toBeLessThan(900);
  });
});
