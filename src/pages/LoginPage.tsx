import { Capacitor } from '@capacitor/core';
import { APK_URL } from '@/lib/app-update';
import { GoogleIdentityButton } from '@/components/auth/GoogleIdentityButton';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Bluetooth, Car, FileText, Loader2, Route, ShieldCheck, Smartphone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PhoneSignIn } from '@/components/auth/PhoneSignIn';
import { BrandLockup } from '@/components/BrandLockup';
import { isNativeApp } from '@/lib/obd/native-ble';

// The public page: what Xpeed does, in plain words, and sign-in in a popup
// (phone code or Google), like Xpot. A new phone number simply gets an
// account, so there is no separate sign-up. Android uses native Google sign-in.

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}

/** Passwordless login: text message or Google, on web and Android. */
function SignInPanel({ nextPath }: { nextPath: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signInWithGoogle, error: authError } = useAuth();
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState('');
  const done = () => navigate(nextPath, { replace: true });

  const google = async () => {
    setGoogleError('');
    setGoogleLoading(true);
    try {
      await signInWithGoogle(nextPath);
      done();
    } catch {
      setGoogleError(t('auth.googleSignInFailed', "We couldn't sign you in with Google. Please try again."));
    } finally { setGoogleLoading(false); }
  };

  return (
      <div className="min-w-0 space-y-5">
        {authError && <Alert variant="destructive"><AlertDescription>{t('auth.unavailable')}</AlertDescription></Alert>}
        <PhoneSignIn onSignedIn={done} />

        <>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {t('landing.or', 'or')}
              <span className="h-px flex-1 bg-border" />
            </div>
            {googleError && (
              <Alert variant="destructive">
                <AlertDescription>{googleError}</AlertDescription>
              </Alert>
            )}
            {isNativeApp() ? <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => void google()} disabled={googleLoading} data-testid="button-google">
              {googleLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <span className="mr-2"><GoogleIcon /></span>}
              {t('landing.google', 'Continue with Google')}
            </Button> : <GoogleIdentityButton onSignedIn={done} />}
        </>

        <p className="text-center text-xs text-muted-foreground">
          {t('auth.signInTerms', 'The first time you sign in, your Xpeed account is created.')}
        </p>
      </div>
  );
}

function SignInHeader() {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 text-center">
      <h2 className="text-xl font-bold">{t('landing.signInTitle', 'Sign in or create your account')}</h2>
      <p className="text-sm text-muted-foreground">{t('landing.signInHint', 'With your phone number: we text you a code. No password.')}</p>
    </div>
  );
}

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const native = isNativeApp();
  // S02: only allow in-app paths; reject protocol-relative (`//evil.com`) and absolute URLs.
  const rawNext = searchParams.get('next');
  const nextPath = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  // Opens by itself when someone was sent here from a page that needs sign-in.
  const [loginOpen, setLoginOpen] = useState(() => searchParams.has('next') || searchParams.has('entrar'));
  const openLogin = () => setLoginOpen(true);

  // Already signed in (e.g. back from Google): straight to the app.
  useEffect(() => {
    if (user) navigate(nextPath, { replace: true });
  }, [user, nextPath, navigate]);


  if (native) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <h1><BrandLockup logoClassName="h-14 w-14" nameClassName="text-3xl" /></h1>
            <p className="text-sm text-muted-foreground">{t('landing.tagline', 'Know if your car is OK, in plain words.')}</p>
          </div>
          <div className="space-y-5 rounded-lg border border-border bg-card p-6">
            {Capacitor.isPluginAvailable('FirebaseAuthentication') ? <>
              <SignInHeader />
              <SignInPanel nextPath={nextPath} />
            </> : <>
              <h2 className="text-xl font-bold">{t('auth.nativeUpdateTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('auth.nativeUpdateHint')}</p>
              <Button asChild className="w-full"><a href={APK_URL}>{t('appVersion.update', 'Update app')}</a></Button>
            </>}
          </div>
        </div>
      </div>
    );
  }

  const features = [
    { icon: Route, title: t('landing.f1Title', 'Trips recorded by themselves'), text: t('landing.f1Text', 'Leave the app open in the car. Every trip is recorded and checked, with nothing to tap.') },
    { icon: ShieldCheck, title: t('landing.f2Title', 'Problems in plain words'), text: t('landing.f2Text', 'If something is off, you see what it means and what to do: wait, book a check-up or stop now.') },
    { icon: FileText, title: t('landing.f3Title', 'A report for the mechanic'), text: t('landing.f3Text', 'Send a link with the fault codes and readings, so the mechanic starts from facts.') },
  ];
  const steps = [
    { icon: Bluetooth, text: t('landing.s1', 'Get an OBD2 adapter with "Bluetooth LE" in the name (for example Veepeak OBDCheck BLE).') },
    { icon: Car, text: t('landing.s2', 'Plug it in under the steering wheel and turn the car on.') },
    { icon: Smartphone, text: t('landing.s3', 'Sign in with your phone, tap "Connect to the car" and pick the adapter. From then on Xpeed does the rest.') },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <BrandLockup />
          <Button size="sm" variant="outline" onClick={openLogin} data-testid="landing-sign-in">
            {t('landing.signInShort', 'Sign in')}
          </Button>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 py-14 lg:py-24">
          <div className="max-w-3xl space-y-6">
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              {t('landing.title', 'Know if your car is OK, without knowing mechanics.')}
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground">
              {t('landing.subtitle', 'A pocket adapter reads your car, Xpeed records every trip on its own and tells you in plain words what needs attention.')}
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>✓ {t('landing.point1', 'Works with most cars from 2008 on')}</li>
              <li>✓ {t('landing.point2', 'Android phone or Chrome on a computer')}</li>
              <li>✓ {t('landing.point3', 'Free to start')}</li>
            </ul>
            <Button size="lg" onClick={openLogin} className="group" data-testid="landing-get-started">
              {t('landing.cta', 'Start now')}
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
          </div>
        </section>

        <section className="border-t border-border bg-card/40">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-12 sm:grid-cols-3">
            {features.map(({ icon: Icon, title, text }) => (
              <div key={title} className="space-y-2 rounded-lg border border-border bg-background p-5">
                <Icon className="h-6 w-6 text-primary" />
                <h2 className="font-semibold">{title}</h2>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl space-y-6 px-4 py-12">
          <h2 className="text-2xl font-bold">{t('landing.howTitle', 'How it works')}</h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {steps.map(({ icon: Icon, text }, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
                <span className="space-y-1">
                  <Icon className="h-5 w-5 text-primary" />
                  <span className="block text-sm text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
          </ol>
          <Button size="lg" onClick={openLogin}>
            {t('landing.cta', 'Start now')}
          </Button>
        </section>
      </main>

      <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
        <p>{t('settings.about.disclaimer', 'It gives hints from data, not a diagnosis — for warning lights or serious symptoms, see a mechanic.')}</p>
        <p className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <Link to="/privacy" className="underline underline-offset-2">{t('legal.links.privacy', 'Privacy Policy')}</Link>
          <Link to="/terms" className="underline underline-offset-2">{t('legal.links.terms', 'Terms of Use')}</Link>
        </p>
      </footer>

      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-h-[92vh] w-[92%] max-w-md grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto rounded-2xl p-5 sm:p-7" data-testid="login-dialog">
          <DialogHeader className="space-y-3 pb-5 text-center sm:text-center">
            <div className="flex justify-center"><BrandLockup logoClassName="h-12 w-12" nameClassName="text-2xl" /></div>
            <DialogTitle className="text-xl">{t('landing.signInTitle', 'Sign in or create your account')}</DialogTitle>
            <DialogDescription>{t('landing.signInHint', 'With your phone number: we text you a code. No password.')}</DialogDescription>
          </DialogHeader>
          <SignInPanel nextPath={nextPath} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
