import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkApkUpdate, type ApkUpdate } from '@/lib/app-update';
import { useAppUpdateBlocked } from '@/hooks/use-app-update-blocked';

/** Android app: "new version available" bar with a one-tap download of the new APK. */
export function AppUpdateBanner() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<ApkUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const blocked = useAppUpdateBlocked();

  useEffect(() => {
    void checkApkUpdate().then(setUpdate);
  }, []);

  if (!update?.available || dismissed) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm" role="status">
      <div className="flex-1 min-w-48">
        <p className="font-medium">{t('updates.apkNeeded', 'Android APK update required')}</p>
        <p className="text-xs text-muted-foreground">{t('updates.builds', 'Installed: build {{installed}} · Required: build {{required}} or newer', { installed: update.installed, required: update.required })}</p>
        {blocked && <p className="text-xs">{t('updates.installWhenReady', 'You can download now. Finish recording and save any changes before installing the APK.')}</p>}
      </div>
      <Button size="sm" asChild>
        {/* Opens in the phone's browser, which downloads the APK and asks to install it over this one. */}
        <a href={update.downloadUrl}>
          <Download className="w-3.5 h-3.5 mr-2" />
          {t('updates.downloadApk', 'Download APK')}
        </a>
      </Button>
      <button type="button" aria-label={t('appUpdate.later', 'Later')} onClick={() => setDismissed(true)} className="text-muted-foreground hover:text-foreground">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
