import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { APK_URL, findAppUpdate } from '@/lib/app-update';

/** Android app: "new version available" bar with a one-tap download of the new APK. */
export function AppUpdateBanner() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void findAppUpdate().then(setUpdate);
  }, []);

  if (!update || dismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm" role="status">
      <span className="flex-1">{t('appUpdate.available', 'A new version of the app is available.')}</span>
      <Button size="sm" asChild>
        {/* Opens in the phone's browser, which downloads the APK and asks to install it over this one. */}
        <a href={APK_URL} target="_blank" rel="noopener noreferrer">
          <Download className="w-3.5 h-3.5 mr-2" />
          {t('appUpdate.install', 'Update')}
        </a>
      </Button>
      <button type="button" aria-label={t('appUpdate.later', 'Later')} onClick={() => setDismissed(true)} className="text-muted-foreground hover:text-foreground">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
