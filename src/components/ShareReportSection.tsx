import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Share2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { createSharedReport, listSharedReports, revokeSharedReport, includeSharedMedia, listSessionPhotos, type SharedReport } from '@/lib/db-extras';
import { publicAppUrl, tripTitle } from '@/lib/trips';
import type { Session } from '@/types/session';
import { formatAppDate } from '@/lib/app-date';

const LINK_DAYS = 30;

/**
 * "Send to the mechanic": makes a read-only public link for one trip (after saying plainly
 * that anyone with it can open the report, VIN included) and lists the links still working
 * so the owner can turn each one off.
 */
export default function ShareReportSection({ session }: { session: Pick<Session, 'id' | 'source_filename' | 'session_start' | 'uploaded_at'> }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [links, setLinks] = useState<SharedReport[]>([]);
  const [includeMedia, setIncludeMedia] = useState(false);

  const loadLinks = useCallback(async () => {
    try {
      setLinks(await listSharedReports(session.id));
    } catch (err) {
      console.warn('Could not load the shared links:', err);
    }
  }, [session.id]);

  useEffect(() => { void loadLinks(); }, [loadLinks]);

  const createLink = async () => {
    setSharing(true);
    try {
      const report = await createSharedReport(session.id, LINK_DAYS);
      if (includeMedia) {
        try {
          const media = await listSessionPhotos(session.id);
          await includeSharedMedia(report.id, media.map((item) => item.id));
        } catch (error) {
          await revokeSharedReport(report.id);
          throw error;
        }
      }
      const url = `${publicAppUrl()}/share/${report.id}${includeMedia ? '?attachments=1' : ''}`;
      const title = tripTitle(session, t);
      if (navigator.share) {
        await navigator.share({ title, text: t('tripDetail.shareText', 'Report of my car: {{title}}', { title }), url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({
          title: t('tripDetail.linkCopied', 'Link copied'),
          variant: 'success',
          description: t('tripDetail.linkCopiedHint', 'Paste it in a message to your mechanic. It works for 30 days.'),
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return; // closed the share sheet
      console.error(err);
      toast({ title: t('tripDetail.shareFailed', "Couldn't create the link"), variant: 'destructive' });
    } finally {
      setSharing(false);
      void loadLinks();
    }
  };

  const turnOff = async (id: string) => {
    try {
      await revokeSharedReport(id);
      setLinks((current) => current.filter((l) => l.id !== id));
      toast({ title: t('sharing.turnedOff', 'Link turned off'), variant: 'success' });
    } catch (err) {
      console.error(err);
      toast({ title: t('sharing.turnOffFailed', "Couldn't turn the link off"), variant: 'destructive' });
    }
  };

  const formatDate = (iso: string) =>
    formatAppDate(new Date(iso), i18n.resolvedLanguage, { day: 'numeric', month: 'short' });

  return (
    <div className="space-y-2">
      <Button size="lg" className="w-full" onClick={() => setConfirming(true)} disabled={sharing}>
        {sharing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />}
        {t('tripDetail.share', 'Send to the mechanic')}
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sharing.confirmTitle', 'Make a public link?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'sharing.confirmBody',
                "Anyone who has the link can open this report without signing in. It shows the car's VIN (chassis number), its fault codes and unusual readings. The link works for {{days}} days, and you can turn it off at any time.",
                { days: LINK_DAYS },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={includeMedia} onChange={(event) => setIncludeMedia(event.target.checked)} className="mt-1 h-4 w-4" />
            <span>{t('sharing.includeMedia', 'Include the current photos, videos and their descriptions. Future uploads will not be added to this link.')}</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void createLink()}>{t('sharing.confirmAction', 'Create link')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {links.length > 0 && (
        <div className="rounded-lg border border-border p-3 space-y-2" data-testid="shared-links">
          <p className="text-sm font-medium">{t('sharing.linksTitle', 'Links you made for this trip')}</p>
          {links.map((link) => (
            <div key={link.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                {t('sharing.linkLine', 'Made {{date}} · opened {{count}} times', { date: formatDate(link.created_at), count: link.view_count })}
                {link.expires_at && ` · ${t('sharing.worksUntil', 'works until {{date}}', { date: formatDate(link.expires_at) })}`}
              </span>
              <Button variant="outline" size="sm" onClick={() => void turnOff(link.id)}>
                {t('sharing.turnOff', 'Turn off')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
