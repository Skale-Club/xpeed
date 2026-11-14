import { useTranslation } from 'react-i18next';
import { Download, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { COMPANION_DOWNLOAD_PATH, formatFileSize, useCompanionRelease } from '@/lib/companion-release';

/**
 * The one download on the Companion page: the yellow button (the stable link, which works even when the version cannot be read) with the version
 * and the size beside it, and a short calm note while the installer is not code-signed (Windows SmartScreen). The checksum of the installer
 * is not shown here (it stays in the release API and in SHA256SUMS.txt).
 */
export function CompanionDownload() {
  const { t } = useTranslation();
  const release = useCompanionRelease();
  const data = release.data;
  const meta = data ? [t('companionSite.version', 'Version {{version}}', { version: data.version }), formatFileSize(data.size)].filter(Boolean).join(' · ') : '';

  return (
    <div className="space-y-2" data-testid="companion-download">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button asChild>
          <a href={COMPANION_DOWNLOAD_PATH} data-testid="companion-download-button"><Download className="mr-2 h-4 w-4" aria-hidden="true" />{t('companionSite.download', 'Download for Windows')}</a>
        </Button>
        {release.isPending ? (
          <Skeleton className="h-4 w-32" data-testid="companion-download-loading" />
        ) : (
          <span className="text-sm text-muted-foreground" data-testid="companion-download-meta">{meta || t('companionSite.noVersion', 'Windows 10 or 11. Free.')}</span>
        )}
      </div>
      {release.isError && <p className="text-xs text-muted-foreground" data-testid="companion-download-unavailable">{t('communityDash.companion.versionUnavailable', 'The latest version could not be read. The download still works.')}</p>}
      {data && !data.signed && (
        <p role="note" className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="companion-smartscreen">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span>{t('communityDash.companion.smartscreen', 'Windows may say the publisher is unknown. Click More info, then Run anyway.')}</span>
        </p>
      )}
    </div>
  );
}
