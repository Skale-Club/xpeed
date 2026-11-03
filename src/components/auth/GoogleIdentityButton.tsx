import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';

interface GoogleAccounts {
  id: {
    initialize(options: { client_id: string; auto_select: boolean; callback: (result: { credential: string }) => void }): void;
    renderButton(element: HTMLElement, options: { theme: string; size: string; width: number; locale?: string }): void;
  };
}
declare global { interface Window { google?: { accounts: GoogleAccounts } } }
let loading: Promise<void> | undefined;
function loadGoogleIdentityServices() {
  if (window.google?.accounts.id) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      script.remove(); loading = undefined; reject(new Error('Google unavailable'));
    }, 15_000);
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.onload = () => { window.clearTimeout(timeout); resolve(); };
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); loading = undefined; reject(new Error('Google unavailable')); };
    document.head.appendChild(script);
  });
  return loading;
}

/** Uses this app's own OAuth client before exchanging the ID token with Google Cloud. */
export function GoogleIdentityButton({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, i18n } = useTranslation();
  const { signInWithGoogleIdToken } = useAuth();
  const target = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ signInWithGoogleIdToken, onSignedIn });
  callbacks.current = { signInWithGoogleIdToken, onSignedIn };
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let pending = false;
    const element = target.current;
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) { setError(true); return; }
    void loadGoogleIdentityServices().then(() => {
      if (!active || !element || !window.google) return;
      window.google.accounts.id.initialize({ client_id: clientId, auto_select: false, callback: ({ credential }) => {
        if (!active || pending) return;
        pending = true;
        setBusy(true); setError(false);
        void callbacks.current.signInWithGoogleIdToken(credential).then(() => { if (active) callbacks.current.onSignedIn(); })
          .catch(() => { if (active) setError(true); }).finally(() => { pending = false; if (active) setBusy(false); });
      } });
      window.google.accounts.id.renderButton(element, {
        theme: 'outline', size: 'large', width: Math.min(400, element.clientWidth),
        locale: (i18n.resolvedLanguage ?? 'en').replace('-', '_'),
      });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; element?.replaceChildren(); };
  }, [i18n.resolvedLanguage]);
  return <div className="space-y-2" aria-busy={busy}>
    <div ref={target} className={busy ? 'pointer-events-none opacity-60' : ''} />
    {busy && <p role="status" className="text-center text-sm text-muted-foreground">{t('auth.signingIn', 'Signing in…')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('auth.googleSignInFailed')}</p>}
  </div>;
}
