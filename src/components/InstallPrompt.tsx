import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { installKind } from '@/lib/device';
import { AndroidAppDownload, IosAddToHome, IphoneNoBluetooth } from '@/components/InstallApp';

const DISMISSED_KEY = 'xpeed.install-offer-dismissed';

function wasDismissed(): boolean {
  try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * The one-time offer to install Xpeed, at the bottom of the screen:
 * - Android browser → the Android app (APK), with how to install it;
 * - iPhone/iPad in Safari → "Add to Home Screen", and a heads-up that the car
 *   connection doesn't work there;
 * - nothing inside the Android app, once added to an iPhone's home screen, or on a computer.
 */
export function InstallPrompt() {
  const { t } = useTranslation();
  const kind = installKind();
  const [open, setOpen] = useState(() =>
    !wasDismissed() && (kind === 'android' || (kind === 'ios' && !isStandalone())));

  if (!open) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* private mode: it just shows again */ }
    setOpen(false);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-4 animate-in slide-in-from-bottom-4 duration-300" data-testid="install-prompt">
      <div className="mx-auto max-h-[85vh] max-w-lg overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 p-4 pb-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
            <img src="/icon-192.png" alt={t('pwa.appIcon', 'App icon')} className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight text-foreground">
              {kind === 'android' ? t('install.android.title', 'Get the Android app') : t('pwa.title', 'Add to Home Screen')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {kind === 'android'
                ? t('install.android.subtitle', 'Records your trips by itself, even with the screen off.')
                : t('pwa.subtitle', 'Open the app in one tap, like any other app')}
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label={t('pwa.close', 'Close')}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 pb-4">
          {kind === 'android' ? (
            <AndroidAppDownload />
          ) : (
            <>
              <IosAddToHome />
              <IphoneNoBluetooth />
            </>
          )}
          <Button variant="outline" size="sm" className="w-full" onClick={dismiss}>
            {kind === 'android' ? t('pwa.notNow', 'Not now') : t('pwa.gotIt', 'Got it')}
          </Button>
        </div>
      </div>
    </div>
  );
}
