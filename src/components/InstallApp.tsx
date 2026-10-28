import { Download, Plus, Share, BluetoothOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { APK_URL } from '@/lib/app-update';
import { cn } from '@/lib/utils';

/** Numbered how-to list, shared by the install offers. */
function Steps({ steps }: { steps: { icon?: JSX.Element; text: string }[] }) {
  return (
    <ol className="space-y-1.5">
      {steps.map(({ icon, text }, i) => (
        <li key={i} className="flex items-start gap-2.5 rounded-xl bg-muted/50 px-3 py-2 text-xs text-foreground">
          <span className="mt-px w-4 shrink-0 text-center font-mono text-muted-foreground">{i + 1}</span>
          {icon}
          <span>{text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Android browser: the download button for the Android app (APK) and how to
 * install it. The app keeps recording with the screen off, which the browser can't.
 */
export function AndroidAppDownload({ className, onDownload }: { className?: string; onDownload?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={cn('space-y-3', className)} data-testid="android-app-download">
      <Button asChild className="w-full gap-2">
        <a href={APK_URL} onClick={onDownload}>
          <Download className="h-4 w-4" />
          {t('install.android.download', 'Download the app')}
        </a>
      </Button>
      <Steps
        steps={[
          { text: t('install.android.step1', 'Tap Download the app and wait for it to finish.') },
          { text: t('install.android.step2', 'Open xpeed.apk from the notification or your Downloads folder.') },
          { text: t('install.android.step3', 'If Android asks, allow installing apps from this browser.') },
          { text: t('install.android.step4', 'Tap Install, then Open, and sign in with the same account.') },
        ]}
      />
      <p className="text-[11px] text-muted-foreground">
        {t('install.android.playStore', "Android may warn that the app isn't from the Play Store. That's expected: it comes straight from Xpeed's site.")}
      </p>
    </div>
  );
}

/** iPhone/iPad: Safari's "Add to Home Screen" steps. */
export function IosAddToHome() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('pwa.iosIntro', 'Follow these steps in Safari:')}</p>
      <Steps
        steps={[
          { icon: <Share className="h-4 w-4 shrink-0 text-primary" />, text: t('pwa.iosStep1', 'Tap the Share button in the browser toolbar') },
          { icon: <Plus className="h-4 w-4 shrink-0 text-primary" />, text: t('pwa.iosStep2', 'Scroll down and tap "Add to Home Screen"') },
          { icon: <Download className="h-4 w-4 shrink-0 text-primary" />, text: t('pwa.iosStep3', 'Tap "Add" to confirm') },
        ]}
      />
    </div>
  );
}

/** Safari has no Bluetooth, so on iPhone the app can't talk to the car (yet). */
export function IphoneNoBluetooth({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={cn('flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground', className)} data-testid="iphone-no-bluetooth">
      <BluetoothOff className="mt-px h-4 w-4 shrink-0 text-warn" />
      <span>{t('install.ios.noBluetooth', "On iPhone, Xpeed can't connect to the car yet: Safari has no Bluetooth. You can still see your trips and problems and talk to the AI.")}</span>
    </p>
  );
}
