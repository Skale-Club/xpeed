import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BrandLockup } from '@/components/BrandLockup';
import { Button } from '@/components/ui/button';
import { LANGUAGES, currentLanguage } from '@/lib/languages';
import { cn } from '@/lib/utils';

// The two public legal pages (/privacy and /terms). One layout, the words live in the `legal` block of the locale
// files. No sign-in, no data, plain markup: a header, a "last updated" date, an anchor index and short sections.

/** The day the texts were last changed. Change it together with the texts. */
export const LEGAL_UPDATED = '2026-11-13';
/** Where the Privacy settings page lives (export and delete). */
export const PRIVACY_SETTINGS_PATH = '/virtual/privacy';

type Doc = 'privacy' | 'terms';
type LinkKind = 'settings' | 'privacy';
interface SectionSpec {
  id: string;
  items?: boolean;
  after?: boolean;
  /** A link shown under the section's text. */
  link?: LinkKind;
}

const SECTIONS: Record<Doc, SectionSpec[]> = {
  privacy: [
    { id: 'who' },
    { id: 'data', items: true },
    { id: 'companion', items: true },
    { id: 'profile' },
    { id: 'why', items: true },
    { id: 'where' },
    { id: 'rights', items: true, after: true, link: 'settings' },
    { id: 'third', items: true },
    { id: 'children' },
    { id: 'changes' },
  ],
  terms: [
    { id: 'service' },
    { id: 'account' },
    { id: 'content', items: true },
    { id: 'fair' },
    { id: 'data', link: 'privacy' },
    { id: 'warranty' },
    { id: 'liability' },
    { id: 'companion' },
    { id: 'ending', link: 'settings' },
    { id: 'changes' },
    { id: 'law' },
  ],
};

/** "Label: text" in a list gets the label in bold. */
function Item({ text }: { text: string }) {
  const cut = text.indexOf(': ');
  if (cut <= 0 || cut > 40) return <li>{text}</li>;
  return (
    <li>
      <strong className="font-semibold text-foreground">{text.slice(0, cut + 1)}</strong>
      {text.slice(cut + 1)}
    </li>
  );
}

/** The contact line: the e-mail from VITE_CONTACT_EMAIL when set (text and mailto link), else where to go instead. */
export function ContactLine() {
  const { t } = useTranslation();
  const email = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined)?.trim();
  if (email) {
    return (
      <p data-testid="legal-contact-email">
        <span>{t('legal.contact.label', 'E-mail')}: </span>
        <a href={`mailto:${email}`} className="select-all font-medium text-primary underline underline-offset-2">{email}</a>
      </p>
    );
  }
  return (
    <p data-testid="legal-contact-fallback">
      {t('legal.contact.without', 'Xpeed does not publish an e-mail address yet. Meanwhile you can export and delete your data yourself on the privacy settings page, without having to talk to anyone.')}{' '}
      <Link to={PRIVACY_SETTINGS_PATH} className="font-medium text-primary underline underline-offset-2">{t('legal.links.settings', 'Privacy settings')}</Link>
    </p>
  );
}

function LanguageLinks() {
  const { t, i18n } = useTranslation();
  const active = currentLanguage(i18n.resolvedLanguage).code;
  return (
    <div className="flex items-center gap-1 text-sm" role="group" aria-label={t('settings.prefs.language', 'Language')}>
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={l.code === active}
          onClick={() => void i18n.changeLanguage(l.code)}
          className={cn(
            'rounded-md px-2 py-1 transition-colors',
            l.code === active ? 'bg-primary/10 font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

export default function LegalDocument({ doc }: { doc: Doc }) {
  const { t, i18n } = useTranslation();
  const sections = SECTIONS[doc];
  const other: Doc = doc === 'privacy' ? 'terms' : 'privacy';

  const date = (() => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(LEGAL_UPDATED));
    } catch {
      return LEGAL_UPDATED;
    }
  })();

  const list = (key: string): string[] => {
    const value = t(key, { returnObjects: true });
    return Array.isArray(value) ? (value as string[]) : [];
  };

  const linkFor = (kind: LinkKind) => kind === 'settings'
    ? <Link to={PRIVACY_SETTINGS_PATH} className="font-medium text-primary underline underline-offset-2">{t('legal.links.settings', 'Privacy settings')}</Link>
    : <Link to="/privacy" className="font-medium text-primary underline underline-offset-2">{t('legal.links.privacy', 'Privacy Policy')}</Link>;

  const contactTitle = t('legal.contact.title', 'Contact');

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <Link to="/" aria-label="Xpeed"><BrandLockup /></Link>
          <div className="flex items-center gap-2">
            <LanguageLinks />
            <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex">
              <Link to="/login">{t('landing.signInShort', 'Sign in')}</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:py-14">
        <div className="space-y-3">
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">{t(`legal.${doc}.title`)}</h1>
          <p className="text-sm text-muted-foreground" data-testid="legal-updated">
            <time dateTime={LEGAL_UPDATED}>{t('legal.updated', { date })}</time>
          </p>
          <p className="text-muted-foreground">{t(`legal.${doc}.intro`)}</p>
        </div>

        <nav aria-label={t('legal.index', 'On this page')} className="rounded-lg border border-border bg-card p-4" data-testid="legal-index">
          <h2 className="mb-2 text-sm font-semibold">{t('legal.index', 'On this page')}</h2>
          <ol className="grid gap-1 text-sm sm:grid-cols-2">
            {[...sections.map((s) => s.id), 'contact'].map((id, index) => (
              <li key={id} className="flex gap-2">
                <span className="w-5 shrink-0 text-right text-muted-foreground">{index + 1}.</span>
                <a href={`#${id}`} className="text-primary underline-offset-2 hover:underline">
                  {id === 'contact' ? contactTitle : t(`legal.${doc}.${id}.title`)}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {sections.map((section, index) => (
          <section key={section.id} id={section.id} className="scroll-mt-20 space-y-3" data-testid={`legal-section-${section.id}`}>
            <h2 className="text-xl font-bold">{index + 1}. {t(`legal.${doc}.${section.id}.title`)}</h2>
            <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              {list(`legal.${doc}.${section.id}.p`).map((text) => <p key={text}>{text}</p>)}
              {section.items && (
                <ul className="list-disc space-y-2 pl-5">
                  {list(`legal.${doc}.${section.id}.items`).map((text) => <Item key={text} text={text} />)}
                </ul>
              )}
              {section.after && list(`legal.${doc}.${section.id}.after`).map((text) => <p key={text}>{text}</p>)}
              {section.link && <p>{linkFor(section.link)}</p>}
            </div>
          </section>
        ))}

        <section id="contact" className="scroll-mt-20 space-y-3" data-testid="legal-section-contact">
          <h2 className="text-xl font-bold">{sections.length + 1}. {contactTitle}</h2>
          <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>{t('legal.contact.body')}</p>
            <ContactLine />
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
        <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <Link to={`/${other}`} className="underline underline-offset-2">{t(`legal.links.${other}`)}</Link>
          <Link to="/companion" className="underline underline-offset-2">Xpeed Companion</Link>
          <Link to="/login" className="underline underline-offset-2">{t('companionSite.footerAccount', 'Xpeed account')}</Link>
        </nav>
      </footer>
    </div>
  );
}
