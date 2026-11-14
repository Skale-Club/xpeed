import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettings } from '@/contexts/SettingsContext';
import { COMPANION_DOWNLOAD_PATH, formatFileSize, useCompanionRelease } from '@/lib/companion-release';
import { copyText } from '../social/social-utils';

/**
 * The newest Xpeed Companion for Windows: the download button (the stable link, which works even when the version cannot be read), the version,
 * the size and the day it came out, the SHA-256 of the installer with a copy button, and, while the installer is not code-signed, what to expect
 * from Windows SmartScreen.
 */
export function CompanionDownload() {
  const { t, i18n } = useTranslation();
  const { timezone } = useSettings();
  const release = useCompanionRelease();
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const data = release.data;
  const date = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { dateStyle: 'medium', timeZone: timezone }).format(new Date(iso));
    } catch {
      return iso;
    }
  };
  const meta = data ? [t('companionSite.version', 'Version {{version}}', { version: data.version }), formatFileSize(data.size), t('communityDash.companion.releasedOn', 'Released {{date}}', { date: date(data.releasedAt) })].filter(Boolean).join(' · ') : '';

  return (
    <Card className="space-y-3 bg-card p-4" data-testid="companion-download-card">
      <h3 className="font-semibold">{t('communityDash.companion.downloadTitle', 'Xpeed Companion for Windows')}</h3>
      {release.isPending ? (
        <Skeleton className="h-4 w-48" data-testid="companion-download-loading" />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="companion-download-meta">
          {meta || t('companionSite.noVersion', 'Windows 10 or 11. Free.')}
        </p>
      )}
      {release.isError && <p className="text-xs text-muted-foreground" data-testid="companion-download-unavailable">{t('communityDash.companion.versionUnavailable', 'The latest version could not be read. The download still works.')}</p>}
      <Button asChild className="w-full sm:w-auto">
        <a href={COMPANION_DOWNLOAD_PATH} data-testid="companion-download-button"><Download className="mr-2 h-4 w-4" />{t('companionSite.download', 'Download for Windows')}</a>
      </Button>
      {data && (
        <div className="space-y-1.5" data-testid="companion-sha">
          <p className="text-xs font-medium text-muted-foreground">SHA-256</p>
          <code className="block select-all break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-snug" data-testid="companion-sha-value">{data.sha256}</code>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={async () => setCopied((await copyText(data.sha256, null)) ? 'yes' : 'no')} data-testid="companion-sha-copy">
              {copied === 'yes' ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              {copied === 'yes' ? t('communityDash.companion.shaCopied', 'Checksum copied') : t('communityDash.companion.copySha', 'Copy checksum')}
            </Button>
            {copied === 'no' && <span className="text-xs text-muted-foreground" role="status">{t('communityDash.companion.copyFailed', 'Could not copy. Select the checksum and copy it.')}</span>}
          </div>
          <p className="text-xs text-muted-foreground">{t('companionSite.checksumHelp', 'SHA-256 of the installer. In PowerShell, Get-FileHash on the downloaded file must give the same value.')}</p>
        </div>
      )}
      {data && !data.signed && (
        <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="companion-smartscreen">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <p>{t('companionSite.smartscreen', 'If Windows warns about an unknown publisher: click More info, then Run anyway. The checksum above lets you verify that the file is the one we published.')}</p>
        </div>
      )}
    </Card>
  );
}
