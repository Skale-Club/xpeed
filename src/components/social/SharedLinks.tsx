import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock, Link2, Share2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadMore } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { compareUrl } from '@/lib/sim/compare-url';
import { sessionPath } from '@/lib/sim/routes';
import { useRevokeShare, useShares, type Share } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { ErrorLine } from './social-bits';
import { aboutShare, lifeSpent } from './social-utils';
import { useErrorText } from './use-error-text';

function LinkCard({ share, onRevoke, busy }: { share: Share; onRevoke: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const about = aboutShare(share, t);
  const spent = lifeSpent(share);
  const status = share.revokedAt ? 'revoked' : share.active ? 'active' : 'expired';
  return (
    <li data-testid="share-row" data-status={status}>
      <Card className={cn('flex h-full flex-col gap-3 bg-card p-4', status !== 'active' && 'opacity-70')}>
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"><Link2 className="h-4 w-4" aria-hidden="true" /></span>
            <span className="truncate">{share.kind === 'lap' ? t('social.share.kindLap', 'Lap link') : t('social.share.kindSession', 'Session link')}</span>
          </p>
          <Badge variant={status === 'active' ? 'default' : 'secondary'} data-testid="share-status">
            {status === 'active' ? t('social.share.statusActive', 'Active') : status === 'revoked' ? t('social.share.revoked', 'Revoked') : t('social.share.expired', 'Expired')}
          </Badge>
        </div>
        {about && <p className="truncate text-sm" data-testid="share-about">{about}</p>}
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>{t('social.share.created', 'Made {{when}}', { when: when(Date.parse(share.createdAt)) })}</p>
          <p className="flex items-center gap-1.5" data-testid="share-expiry-line">
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {share.revokedAt
              ? t('social.share.revokedOn', 'Revoked {{when}}', { when: when(Date.parse(share.revokedAt)) })
              : share.expiresAt
                ? share.active
                  ? t('social.share.expires', 'Stops working {{when}}', { when: when(Date.parse(share.expiresAt)) })
                  : t('social.share.expiredOn', 'Expired {{when}}', { when: when(Date.parse(share.expiresAt)) })
                : t('social.share.noExpiry', 'No end date')}
          </p>
          {spent !== null && share.active && (
            <span className="block h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.round(spent * 100)}%` }} data-testid="share-life" />
            </span>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={share.sessionId ? sessionPath(share.sessionId) : compareUrl(share.lapId ?? '')}>{t('social.share.open', 'Open')}</Link>
          </Button>
          {share.active && (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              onClick={onRevoke}
              aria-label={t('social.share.revokeLabel', 'Revoke the link made {{when}}', { when: when(Date.parse(share.createdAt)) })}
              data-testid="share-revoke"
            >
              {t('social.share.revoke', 'Revoke')}
            </Button>
          )}
        </div>
      </Card>
    </li>
  );
}

/**
 * The links the person made, as cards: what each is about, whether it is live, when it ends (with how much of its life is gone) and Open and
 * Revoke (after a question; at once for everybody). Live links first; expired and revoked ones only when asked for. The address of a link is
 * never here: the server shows it once, when the link is made, so it cannot be copied again.
 */
export function SharedLinks() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const shares = useShares();
  const revoke = useRevokeShare();
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<Share | null>(null);
  const live = useMemo(() => shares.items.filter((share) => share.active), [shares.items]);
  const ended = useMemo(() => shares.items.filter((share) => !share.active), [shares.items]);
  const rows = showAll ? [...live, ...ended] : live;

  if (shares.isPending) return <Skeleton className="h-28 w-full rounded-xl" data-testid="share-loading" />;
  if (shares.isError && shares.items.length === 0) return <ErrorLine>{errorText(shares.error)}</ErrorLine>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5" data-testid="share-count"><Share2 className="h-3.5 w-3.5" aria-hidden="true" />{t('social.share.liveCount', 'Live links: {{count}}', { count: live.length })}</p>
        {ended.length > 0 && (
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" data-testid="share-show-ended" />
            {t('social.share.showEnded', 'Show expired and revoked links ({{count}})', { count: ended.length })}
          </label>
        )}
      </div>
      {rows.length === 0 && !shares.hasNextPage ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="share-none">{t('social.share.none', 'No links yet.')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="share-list">
          {rows.map((share) => <LinkCard key={share.id} share={share} busy={revoke.isPending} onRevoke={() => setPending(share)} />)}
        </ul>
      )}
      {revoke.isError && <ErrorLine>{errorText(revoke.error)}</ErrorLine>}
      <LoadMore hasNextPage={!!shares.hasNextPage} isFetchingNextPage={shares.isFetchingNextPage} onClick={() => void shares.fetchNextPage()} />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={t('social.share.revokeTitle', 'Revoke this link?')}
        description={t('social.share.revokeBody', 'The link stops working at once. To share it again you make a new one.')}
        confirmLabel={t('social.share.revoke', 'Revoke')}
        onConfirm={() => {
          if (pending) revoke.mutate(pending.id);
          setPending(null);
        }}
      />
    </div>
  );
}
