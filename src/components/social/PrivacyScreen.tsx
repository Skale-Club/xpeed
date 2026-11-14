import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Download, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryGate } from '@/components/sim/SimStates';
import { useAuth } from '@/contexts/AuthContext';
import { clearCache } from '@/lib/sim/library';
import {
  DELETE_SENTENCE, EXPORT_FILE_NAME, deleteMyRacingData, exportMyData, useMyProfile, useUpdateProfile, type DeletedSummary, type Visibility,
} from '@/lib/sim/social-client';
import { ErrorLine, SettingsSection, VisibilityPicker } from './social-bits';
import { downloadBlob } from './social-utils';
import { useErrorText } from './use-error-text';

/** The three choices of who can see the profile, saved the moment one is picked, with what went wrong or "Saved" under them. */
function VisibilityControl({ withDataLink = false }: { withDataLink?: boolean }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const query = useMyProfile();
  const update = useUpdateProfile();
  const [saved, setSaved] = useState(false);
  const choose = async (visibility: Visibility) => {
    setSaved(false);
    try {
      await update.mutateAsync({ visibility });
      setSaved(true);
    } catch {
      /* shown below */
    }
  };
  return (
    <QueryGate query={query} empty={false} skeleton={<Skeleton className="h-40 w-full rounded-lg" />}>
      {query.data && (
        <div className="space-y-2">
          <VisibilityPicker value={query.data.visibility} onChange={(value) => void choose(value)} disabled={update.isPending} name="privacy-visibility" />
          {update.isError && <ErrorLine testId="visibility-error">{errorText(update.error)}</ErrorLine>}
          {saved && !update.isPending && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="visibility-saved">
              <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden /> {t('social.profile.saved', 'Saved')}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <Link to="/virtual/profile" className="underline">{t('social.privacy.profileLink', 'Handle, name and shared links')}</Link>
          </p>
          {withDataLink && (
            <p className="text-xs text-muted-foreground">
              <Link to="/virtual/privacy" className="underline">{t('social.settings.dataLink', 'Download or delete my racing data')}</Link>
            </p>
          )}
        </div>
      )}
    </QueryGate>
  );
}

/** `withDataLink`: Settings shows the option and points to the page with the data download and delete. */
export function VisibilitySection({ withDataLink = false }: { withDataLink?: boolean }) {
  const { t } = useTranslation();
  return (
    <Card className="bg-card border-border" data-testid="privacy-visibility">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{t('social.visibility.label', 'Who can see your profile')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <VisibilityControl withDataLink={withDataLink} />
      </CardContent>
    </Card>
  );
}

function DownloadSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setState('working');
    setError(null);
    try {
      downloadBlob(await exportMyData(), EXPORT_FILE_NAME);
      setState('done');
    } catch (failure) {
      setError(failure);
      setState('idle');
    }
  };
  return (
    <SettingsSection
      testId="privacy-download"
      title={t('social.privacy.downloadTitle', 'Download my data')}
      description={t('social.privacy.downloadHint', 'A copy of what Xpeed Virtual holds about you, whenever you want it.')}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t('social.privacy.downloadBody', 'One file with your profile, friends (by handle), sessions, laps, personal bests, paired computers, share links and the reports you made. It has no e-mail, no keys and nothing of other people. The lap files themselves are not in it.')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void run()} disabled={state === 'working'} data-testid="export-button">
            {state === 'working' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            {t('social.privacy.download', 'Download my data')}
          </Button>
          {state === 'done' && <span className="text-sm text-muted-foreground" role="status" data-testid="export-done">{t('social.privacy.downloaded', 'Your file was saved as {{name}}.', { name: EXPORT_FILE_NAME })}</span>}
        </div>
        {error !== null && <ErrorLine testId="export-error">{errorText(error)}</ErrorLine>}
      </div>
    </SettingsSection>
  );
}

function DeleteSection({ onDeleted }: { onDeleted: (summary: DeletedSummary) => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const client = useQueryClient();
  const userId = useAuth().user?.id ?? null;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const matches = typed === DELETE_SENTENCE;

  const close = (next: boolean) => {
    if (working) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setError(null);
    }
  };

  const run = async () => {
    if (!matches) return;
    setWorking(true);
    setError(null);
    try {
      const summary = await deleteMyRacingData();
      // What this device kept of the account goes too: the answers read from the server, the downloaded lap files, the lap library.
      client.removeQueries({ queryKey: ['sim-v1'] });
      client.removeQueries({ queryKey: ['sim-lap-file'] });
      client.removeQueries({ queryKey: ['sim-public-share-file'] });
      if (userId) await clearCache(userId);
      setOpen(false);
      onDeleted(summary);
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(false);
    }
  };

  return (
    <SettingsSection
      danger
      testId="privacy-delete"
      title={t('social.privacy.dangerTitle', 'Danger zone')}
      description={t('social.privacy.dangerHint', 'What you do here cannot be undone.')}
    >
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">{t('social.privacy.deleteTitle', 'Delete my racing data')}</h4>
        <p className="text-sm text-muted-foreground">
          {t('social.privacy.deleteBody', 'Erases everything you have in Xpeed Virtual: your laps and their files, sessions, personal bests, track layouts, share links, friends, reports, your handle and profile, and your paired computers. Your Xpeed account stays, and so does everything in Real car. This cannot be undone.')}
        </p>
        <Button variant="destructive" onClick={() => setOpen(true)} data-testid="delete-open">
          <Trash2 className="mr-2 h-4 w-4" /> {t('social.privacy.deleteButton', 'Delete my racing data…')}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent data-testid="delete-dialog">
          <DialogHeader>
            <DialogTitle>{t('social.privacy.confirmTitle', 'Delete all your racing data?')}</DialogTitle>
            <DialogDescription>
              {t('social.privacy.confirmBody', 'Your laps, sessions, friends, share links, handle and profile are erased for good, and the files of your laps are removed. Your account stays. Paired computers stop working until you pair them again. Download your data first if you want a copy.')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <label htmlFor="delete-sentence" className="block text-sm">
              {t('social.privacy.typeSentence', 'To confirm, type this sentence exactly (in English):')}{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" data-testid="delete-sentence">{DELETE_SENTENCE}</code>
            </label>
            <Input
              id="delete-sentence"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={working}
              data-testid="delete-input"
            />
            {error !== null && <ErrorLine testId="delete-error">{errorText(error)}</ErrorLine>}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={working}>{t('common.cancel', 'Cancel')}</Button>
              <Button type="submit" variant="destructive" disabled={!matches || working} data-testid="delete-confirm">
                {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('social.privacy.confirmDelete', 'Delete everything')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

/** What was erased, in words, after the fact. */
function DeletedPage({ summary }: { summary: DeletedSummary }) {
  const { t } = useTranslation();
  return (
    <Card className="bg-card border-border" data-testid="delete-success">
      <CardContent className="space-y-3 p-6 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-green-500" aria-hidden />
        <h3 className="text-lg font-semibold">{t('social.privacy.deletedTitle', 'Your racing data was deleted')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('social.privacy.deletedBody', '{{laps}} laps, {{sessions}} sessions, {{shares}} share links and {{friends}} friendships were erased. Your account is still here. If you use Virtual again, you start with a new profile.', {
            laps: summary.laps, sessions: summary.sessions, shares: summary.shares, friends: summary.friendships,
          })}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild size="sm"><Link to="/virtual">{t('social.privacy.toOverview', 'Back to Overview')}</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Virtual > Privacy, as a settings page: who can see the profile (the same choice as in the profile settings, saved at once, each with what it
 * shows), Download my data (one JSON file, saved through the person's own click), a danger zone with Delete my racing data (the person types the
 * exact sentence; the account stays), and the privacy policy and terms.
 */
export function PrivacyScreen() {
  const { t } = useTranslation();
  const [deleted, setDeleted] = useState<DeletedSummary | null>(null);
  if (deleted) return <DeletedPage summary={deleted} />;
  return (
    <div className="space-y-8" data-testid="privacy-screen">
      <SettingsSection
        testId="privacy-visibility"
        title={t('social.visibility.label', 'Who can see your profile')}
        description={t('social.privacy.visibilityHint', 'Saved the moment you choose. Your laps stay yours whatever you pick.')}
      >
        <VisibilityControl />
      </SettingsSection>
      <DownloadSection />
      <DeleteSection onDeleted={setDeleted} />
      <p className="text-sm text-muted-foreground" data-testid="privacy-links">
        {t('social.privacy.read', 'Read how your data is handled:')}{' '}
        <Link to="/privacy" className="underline">{t('social.privacy.policy', 'Privacy policy')}</Link>
        {' · '}
        <Link to="/terms" className="underline">{t('social.privacy.terms', 'Terms of use')}</Link>
      </p>
    </div>
  );
}
