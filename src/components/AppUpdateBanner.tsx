import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppUpdate } from '@/hooks/use-app-update';
import { ignoreAppUpdate } from '@/lib/app-update-monitor';
import { useAppUpdateBlocked } from '@/hooks/use-app-update-blocked';

/** Android app: "new version available" bar with a one-tap download of the new APK. */
export function AppUpdateBanner() {
  const { t } = useTranslation();
  const { update, ignoredBuild } = useAppUpdate();
  const blocked = useAppUpdateBlocked();

  if (!update?.available || ignoredBuild === update.required) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm" role="status">
      <div className="flex-1 min-w-48">
        <p className="font-medium">{t('appVersion.available', 'A new version of Xpeed is available')}</p>
        <p className="text-xs text-muted-foreground">{t('appVersion.hint', 'Update to get the latest app improvements.')}</p>
        {blocked && <p className="text-xs">{t('updates.installWhenReady', 'You can download now. Finish recording and save any changes before installing the APK.')}</p>}
      </div>
      <Button size="sm" asChild>
        {/* Opens in the phone's browser, which downloads the APK and asks to install it over this one. */}
        <a href={update.downloadUrl}>
          <Download className="w-3.5 h-3.5 mr-2" />
          {t('appVersion.update', 'Update app')}
        </a>
      </Button>
      <button type="button" aria-label={t('appUpdate.later', 'Later')} onClick={ignoreAppUpdate} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
