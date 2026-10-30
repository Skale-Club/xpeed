import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { checkApkUpdate, isLiveSiteApp, type ApkUpdate } from '@/lib/app-update';
import { isNativeApp } from '@/lib/obd/native-ble';
import { reloadAppScreens } from '@/lib/pwa-update';
import { useAppUpdateBlocked } from '@/hooks/use-app-update-blocked';

export default function AppUpdates({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const native = isNativeApp();
  const bundled = native && !isLiveSiteApp();
  const held = useAppUpdateBlocked();
  const blocked = held || disabled;
  const [apk, setApk] = useState<ApkUpdate | null>(null);
  const [checking, setChecking] = useState(native);
  const [reloading, setReloading] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (!reloading) return;
    const timer = window.setTimeout(() => {
      setReloading(false);
      setFeedback(t('updates.reloadFailed', 'Could not reload. Check your internet connection and try again.'));
    }, 20000);
    return () => window.clearTimeout(timer);
  }, [reloading, t]);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    void checkApkUpdate().then((result) => {
      if (!cancelled) { setApk(result); setChecking(false); }
    });
    return () => { cancelled = true; };
  }, [native]);

  const check = async () => {
    setChecking(true);
    try { setApk(await checkApkUpdate(true)); }
    finally { setChecking(false); }
  };
  const reload = async () => {
    setFeedback(''); setReloading(true);
    try {
      if (await reloadAppScreens() === 'blocked') {
        setFeedback(t('updates.blocked', 'Finish recording and save any changes before updating.'));
        setReloading(false);
      }
    } catch {
      setFeedback(t('updates.reloadFailed', 'Could not reload. Check your internet connection and try again.'));
      setReloading(false);
    }
  };

  return <Card>
    <CardContent className="p-4 space-y-4">
      <h3 className="text-sm font-semibold flex items-center gap-3"><RefreshCw className="h-5 w-5 text-primary" />{t('updates.title', 'Updates')}</h3>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t('updates.screens', 'App screens')}</h4>
        <p className="text-sm text-muted-foreground">{bundled
          ? t('updates.bundled', 'This offline edition includes the screens in the APK. Install a new APK to update them.')
          : t('updates.reloadHint', 'Load the latest screens over the internet. No APK installation needed.')}</p>
        {!bundled && <Button variant="outline" onClick={() => void reload()} disabled={blocked || reloading}>
          {reloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {reloading ? t('updates.reloading', 'Reloading screens…') : t('updates.reload', 'Reload screens')}
        </Button>}
        {feedback && <p role="alert" className="text-sm text-destructive">{feedback}</p>}
      </div>
      {native && <div className="border-t border-border pt-4 space-y-2">
        <h4 className="text-sm font-medium">{t('updates.apk', 'Android APK')}</h4>
        <p className="text-sm text-muted-foreground">{t('updates.apkHint', 'Updates Bluetooth and Android background recording. Install over the existing app; do not uninstall it.')}</p>
        <p role="status" className="text-sm">{checking ? t('updates.checking', 'Checking APK…') : !apk || apk.required === null
          ? t('updates.checkFailed', 'Could not verify whether an APK update is needed. Try again.')
          : apk.available ? t('updates.builds', 'Installed: build {{installed}} · Required: build {{required}} or newer', { installed: apk.installed, required: apk.required })
          : t('updates.apkCurrent', 'Installed: build {{installed}}. No APK update needed.', { installed: apk.installed })}</p>
        {apk?.available && <Button asChild>
          {/* Same-window external navigation is handed to Android's browser by Capacitor. */}
          <a href={apk.downloadUrl}><Download className="mr-2 h-4 w-4" />{t('updates.downloadApk', 'Download APK')}</a>
        </Button>}
        {apk?.available && blocked && <p className="text-xs text-muted-foreground">{t('updates.installWhenReady', 'You can download now. Finish recording and save any changes before installing the APK.')}</p>}
        <Button variant="ghost" onClick={() => void check()} disabled={checking || reloading}>{t('updates.checkApk', 'Check APK')}</Button>
      </div>}
      {blocked && !bundled && <p role="status" className="text-xs text-muted-foreground">{t('updates.reloadBlocked', 'Screen reload is paused until recording ends and your changes are saved.')}</p>}
    </CardContent>
  </Card>;
}
