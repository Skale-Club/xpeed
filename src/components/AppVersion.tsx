import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppUpdate } from '@/hooks/use-app-update';
import { isNativeApp } from '@/lib/obd/native-ble';
import { Button } from '@/components/ui/button';

/** Version and update action live together in About Xpeed. */
export function AppVersion() {
  const { t } = useTranslation();
  const { update, checked } = useAppUpdate();
  if (!isNativeApp()) return null;
  return <div className="space-y-2">
    {update && <p className="text-sm font-semibold" data-testid="app-version">
      {t('install.version', 'Version {{version}} (build {{build}})', { version: update.installedVersion, build: update.installed })}
    </p>}
    <p className="text-sm text-muted-foreground" role="status">{!checked
      ? t('appVersion.loading', 'Loading version…')
      : !update || update.required === null
        ? t('appVersion.unknown', 'Updates are checked automatically when you are online.')
        : update.available ? t('appVersion.outdated', 'An update is available for your app.')
          : t('appVersion.current', 'Your app is up to date.')}</p>
    {update?.available && <Button asChild className="w-full sm:w-auto"><a href={update.downloadUrl}>
      <Download className="h-4 w-4" />{t('appVersion.update', 'Update app')}
    </a></Button>}
  </div>;
}
