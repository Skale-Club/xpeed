import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, Download, Flag, Plug, ShieldCheck, TriangleAlert } from 'lucide-react';
import { BrandLockup } from '@/components/BrandLockup';
import { Button } from '@/components/ui/button';
import { COMPANION_DOWNLOAD_PATH, formatFileSize, useCompanionRelease } from '@/lib/companion-release';

// The public page of Xpeed Companion, the Windows app that reads your racing game: what it is, the download
// (the stable /api/companion/download link), the version and checksum from /api/companion/latest, three steps,
// the games, and a short FAQ. No sign-in, no heavy libraries: plain markup, <details> for the folds.

const CERTIFIED = ['Assetto Corsa', 'Automobilista 2'];
const BETA = ['Le Mans Ultimate', 'Assetto Corsa Competizione', 'Assetto Corsa EVO', 'F1 25', 'Wreckfest 2', 'iRacing', 'RaceRoom', 'rFactor', 'Forza'];

function Chip({ children, tone }: { children: string; tone: 'certified' | 'beta' }) {
  return (
    <li
      className={
        tone === 'certified'
          ? 'rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-sm font-medium text-foreground'
          : 'rounded-full border border-border bg-background px-3 py-1 text-sm text-muted-foreground'
      }
    >
      {children}
    </li>
  );
}

export default function CompanionPage() {
  const { t, i18n } = useTranslation();
  const { data: release } = useCompanionRelease();

  const date = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const steps = [
    { title: t('companionSite.step1Title', 'Install'), text: t('companionSite.step1Text', 'Run the installer. Xpeed Companion starts with Windows and stays in the tray, next to the clock.') },
    {
      title: t('companionSite.step2Title', 'Open it and connect'),
      text: t('companionSite.step2Text', 'Click Connect to your account. Your browser opens on Xpeed and asks you once to confirm. The page shows a 4-letter verification code: check that it is the same one shown in the app, then confirm.'),
    },
    {
      title: t('companionSite.step3Title', 'Drive and see your laps'),
      text: t('companionSite.step3Text', 'Start your game and drive. Each lap arrives in the Virtual area of your Xpeed account, with its track map, speed and pedals.'),
    },
  ];
  const faq = [
    { q: t('companionSite.faqSentQ', 'What is sent?'), a: t('companionSite.faqSentA', 'Your laps (lap time, car, track and the readings of each lap), the track layouts, and the name of your computer so you can recognise it in your account. Nothing else is read from your PC.') },
    { q: t('companionSite.faqDisconnectQ', 'How do I disconnect?'), a: t('companionSite.faqDisconnectA', 'In Xpeed, open Virtual > Xpeed Companion and click Revoke next to the computer. It can no longer send laps; laps already sent stay in your account. To pause recording, use the icon in the tray.') },
    { q: t('companionSite.faqFilesQ', 'Where are the files kept?'), a: t('companionSite.faqFilesA', 'Laps are saved in Documents\\Xpeed Companion\\Laps. Settings and the log are in %APPDATA%\\Xpeed Companion. The key that connects your PC to your account is protected by Windows and never shown.') },
    { q: t('companionSite.faqRemoveQ', 'How do I remove it?'), a: t('companionSite.faqRemoveA', 'Windows Settings > Apps > Installed apps > Xpeed Companion > Uninstall. Then revoke the computer in your account. Your lap files in Documents are not deleted.') },
  ];

  const size = release ? formatFileSize(release.size) : '';
  const meta = release
    ? [t('companionSite.version', 'Version {{version}}', { version: release.version }), size, date(release.releasedAt)].filter(Boolean).join(' · ')
    : '';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link to="/" aria-label="Xpeed"><BrandLockup /></Link>
          <Button asChild size="sm" variant="outline">
            <Link to="/login">{t('landing.signInShort', 'Sign in')}</Link>
          </Button>
        </div>
      </header>

      <main>
        <section className="bg-gradient-to-b from-primary/10 to-transparent">
          <div className="mx-auto max-w-5xl space-y-6 px-4 py-12 sm:py-16">
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">{t('companionSite.title', 'Xpeed Companion')}</h1>
            <p className="max-w-2xl text-lg text-muted-foreground">
              {t('companionSite.intro', 'Xpeed Companion is a small Windows app that reads the telemetry of your racing game while you drive. Every lap goes to your Xpeed account, where you can see it, compare it and get faster.')}
            </p>

            <div className="max-w-xl space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
              <Button asChild size="lg" className="h-14 w-full text-base font-semibold sm:w-auto sm:px-8" data-testid="companion-download">
                <a href={COMPANION_DOWNLOAD_PATH}>
                  <Download className="mr-2 h-5 w-5" />
                  {t('companionSite.download', 'Download for Windows')}
                </a>
              </Button>
              <p className="text-sm text-muted-foreground" data-testid="companion-meta">
                {meta || t('companionSite.noVersion', 'Windows 10 or 11. Free.')}
              </p>
              {release && (
                <details className="group text-sm" data-testid="companion-checksum">
                  <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-primary [&::-webkit-details-marker]:hidden">
                    <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                    {t('companionSite.showChecksum', 'Show checksum')}
                  </summary>
                  <div className="mt-2 space-y-1">
                    <p className="text-muted-foreground">{t('companionSite.checksumHelp', 'SHA-256 of the installer. In PowerShell, Get-FileHash on the downloaded file must give the same value.')}</p>
                    <code className="block select-all break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{release.sha256}</code>
                  </div>
                </details>
              )}
            </div>

            {release && !release.signed && (
              <div role="note" className="flex max-w-xl items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm" data-testid="companion-smartscreen">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p>{t('companionSite.smartscreen', 'If Windows warns about an unknown publisher: click More info, then Run anyway. The checksum above lets you verify that the file is the one we published.')}</p>
              </div>
            )}
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl space-y-6 px-4 py-12">
            <h2 className="text-2xl font-bold">{t('companionSite.stepsTitle', 'Three steps')}</h2>
            <ol className="grid gap-4 sm:grid-cols-3">
              {steps.map((step, index) => (
                <li key={step.title} className="space-y-2 rounded-lg border border-border bg-card p-5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{index + 1}</span>
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-border bg-card/40">
          <div className="mx-auto max-w-5xl space-y-6 px-4 py-12">
            <h2 className="text-2xl font-bold">{t('companionSite.gamesTitle', 'Games')}</h2>
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-5 w-5 text-primary" />{t('companionSite.certified', 'Certified')}</h3>
              <p className="text-sm text-muted-foreground">{t('companionSite.certifiedText', 'Tested with the real game: laps, track map and inputs are checked.')}</p>
              <ul className="flex flex-wrap gap-2" data-testid="companion-certified">{CERTIFIED.map((game) => <Chip key={game} tone="certified">{game}</Chip>)}</ul>
            </div>
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 font-semibold"><Flag className="h-5 w-5 text-muted-foreground" />{t('companionSite.beta', 'Beta')}</h3>
              <p className="text-sm text-muted-foreground">{t('companionSite.betaText', 'Supported, but still being checked with the real game. Some data may be missing.')}</p>
              <ul className="flex flex-wrap gap-2" data-testid="companion-beta">{BETA.map((game) => <Chip key={game} tone="beta">{game}</Chip>)}</ul>
            </div>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl space-y-4 px-4 py-12">
            <h2 className="flex items-center gap-2 text-2xl font-bold"><Plug className="h-6 w-6 text-primary" />{t('companionSite.faqTitle', 'Questions')}</h2>
            <div className="max-w-3xl divide-y divide-border rounded-lg border border-border">
              {faq.map((item) => (
                <details key={item.q} className="group p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="mt-2 text-sm text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('companionSite.privacy', 'Privacy: Xpeed Companion reads only the telemetry your racing game publishes and sends laps only to your own Xpeed account, over HTTPS.')}</p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
        <Link to="/login" className="underline underline-offset-2">{t('companionSite.footerAccount', 'Xpeed account')}</Link>
      </footer>
    </div>
  );
}
