import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Link2, Loader2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadMore } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { sessionPath } from '@/lib/sim/routes';
import { useCreateShare, useRevokeShare, useShares, type CreatedShare, type Share } from '@/lib/sim/social-client';
import { ErrorLine, PlainSelect } from './social-bits';
import { aboutShare, copyText, shareUrl } from './social-utils';
import { useErrorText } from './use-error-text';

export type ShareTarget = { lapId: string } | { sessionId: string };

const matches = (share: Share, target: ShareTarget) => ('lapId' in target ? share.lapId === target.lapId : share.sessionId === target.sessionId);

/** The list of live links to this lap or session, each with a Revoke button. The token is never here: the server gave it once. */
export function ActiveLinks({ target, onlyActive = true }: { target?: ShareTarget; onlyActive?: boolean }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const errorText = useErrorText();
  const shares = useShares();
  const revoke = useRevokeShare();
  const rows = useMemo(
    () => shares.items.filter((share) => (!onlyActive || share.active) && (!target || matches(share, target))),
    [shares.items, target, onlyActive],
  );
  if (shares.isPending) return <p className="text-xs text-muted-foreground" role="status">{t('common.loading', 'Loading…')}</p>;
  if (shares.isError && shares.items.length === 0) return <ErrorLine>{errorText(shares.error)}</ErrorLine>;
  if (rows.length === 0 && !shares.hasNextPage) {
    return <p className="text-sm text-muted-foreground" data-testid="share-none">{t('social.share.none', 'No links yet.')}</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-lg border border-border" data-testid="share-list">
        {rows.map((share) => (
          <li key={share.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm" data-testid="share-row">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 font-medium">
                <Link2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                {share.kind === 'lap' ? t('social.share.kindLap', 'Lap link') : t('social.share.kindSession', 'Session link')}
              </p>
              {!target && aboutShare(share, t) && <p className="truncate text-xs" data-testid="share-about">{aboutShare(share, t)}</p>}
              <p className="text-xs text-muted-foreground">
                {t('social.share.created', 'Made {{when}}', { when: when(Date.parse(share.createdAt)) })}
                {' · '}
                {share.revokedAt
                  ? t('social.share.revoked', 'Revoked')
                  : share.expiresAt
                    ? share.active
                      ? t('social.share.expires', 'Stops working {{when}}', { when: when(Date.parse(share.expiresAt)) })
                      : t('social.share.expired', 'Expired')
                    : t('social.share.noExpiry', 'No end date')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!target && (
                <Button asChild size="sm" variant="ghost">
                  <Link to={share.sessionId ? sessionPath(share.sessionId) : compareUrl(share.lapId ?? '')}>{t('social.share.open', 'Open')}</Link>
                </Button>
              )}
              {share.active && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(share.id)}
                  aria-label={t('social.share.revokeLabel', 'Revoke the link made {{when}}', { when: when(Date.parse(share.createdAt)) })}
                  data-testid="share-revoke"
                >
                  {t('social.share.revoke', 'Revoke')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {revoke.isError && <ErrorLine>{errorText(revoke.error)}</ErrorLine>}
      <LoadMore hasNextPage={!!shares.hasNextPage} isFetchingNextPage={shares.isFetchingNextPage} onClick={() => void shares.fetchNextPage()} />
    </div>
  );
}

/**
 * Share a lap or a whole session by link. Makes the link (never expires, or in 7 or 30 days), shows its address ONCE with a copy
 * button (the server keeps only a hash, so it cannot be shown again), and lists the live links to this item so they can be revoked.
 */
export function ShareDialog({ open, onOpenChange, target, title }: { open: boolean; onOpenChange: (open: boolean) => void; target: ShareTarget; title?: string }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const create = useCreateShare();
  const [expiry, setExpiry] = useState<'never' | '7' | '30'>('never');
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // Closing the dialog forgets the address: that is the only time it can be read.
  useEffect(() => {
    if (open) return;
    setCreated(null);
    setCopied(null);
    setExpiry('never');
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const make = async () => {
    setCopied(null);
    try {
      const result = await create.mutateAsync({ ...target, ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }) });
      setCreated(result);
    } catch {
      /* shown below from create.error */
    }
  };

  const url = created ? shareUrl(created.token) : '';
  const heading = title ?? ('lapId' in target ? t('social.share.titleLap', 'Share this lap') : t('social.share.titleSession', 'Share this session'));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {t('social.share.body', 'Anyone who has the link can see it, with or without an account. They cannot see anything else of yours.')}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3" data-testid="share-created">
            <label className="block space-y-1 text-xs font-medium text-muted-foreground">
              {t('social.share.link', 'Your link')}
              <textarea
                ref={field}
                readOnly
                rows={2}
                value={url}
                onFocus={(event) => event.currentTarget.select()}
                className="block w-full resize-none break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-snug text-foreground"
                data-testid="share-url"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => setCopied((await copyText(url, field.current)) ? 'yes' : 'no')}
                data-testid="share-copy"
              >
                {copied === 'yes' ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {copied === 'yes' ? t('social.share.copied', 'Copied') : t('social.share.copy', 'Copy link')}
              </Button>
              {copied === 'no' && <span className="text-xs text-muted-foreground" role="status">{t('social.share.copyFailed', 'Could not copy. Select the link and copy it.')}</span>}
            </div>
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="share-once">
              {t('social.share.once', 'This is the only time the link is shown. If you lose it, revoke it below and make a new one.')}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <PlainSelect
                label={t('social.share.expiry', 'The link works')}
                value={expiry}
                onChange={(value) => setExpiry(value as 'never' | '7' | '30')}
                options={[
                  { value: 'never', label: t('social.share.never', 'Until I revoke it') },
                  { value: '7', label: t('social.share.days7', 'For 7 days') },
                  { value: '30', label: t('social.share.days30', 'For 30 days') },
                ]}
                testId="share-expiry"
              />
            </div>
            <Button onClick={() => void make()} disabled={create.isPending} data-testid="share-create">
              {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              {t('social.share.create', 'Create link')}
            </Button>
          </div>
        )}
        {create.isError && <ErrorLine testId="share-error">{errorText(create.error)}</ErrorLine>}

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t('social.share.active', 'Active links')}</h3>
          <ActiveLinks target={target} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A "Share" button that opens the share dialog for a lap or a session. `compact` is an icon only (a table row). */
export function ShareButton({ target, compact, label, title }: { target: ShareTarget; compact?: boolean; label?: string; title?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = label ?? t('social.share.button', 'Share');
  return (
    <>
      {compact ? (
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={text} title={text} onClick={() => setOpen(true)} data-testid="share-button">
          <Share2 className="h-4 w-4" />
        </Button>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="share-button">
          <Share2 className="mr-2 h-4 w-4" /> {text}
        </Button>
      )}
      <ShareDialog open={open} onOpenChange={setOpen} target={target} title={title} />
    </>
  );
}
