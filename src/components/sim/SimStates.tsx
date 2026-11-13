import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isSignedOut } from '@/lib/sim/v1-client';
import { useAge } from './use-age';

/** A placeholder shaped like the rows a list is about to show. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="sim-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-lg" />
      ))}
    </div>
  );
}

/**
 * What to say when there are no laps: invite the person to install Xpeed Companion (the public page) and to connect it to the
 * account (the Companion screen). Laps only ever come from there.
 */
export function CompanionInvite({ body, testId = 'sim-empty' }: { body?: string; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-4" data-testid={testId}>
      <p className="text-sm text-muted-foreground">
        {body ?? t('modes.states.empty', 'No laps yet. Install Xpeed Companion on the computer you race on and connect it to your account: your laps show up here by themselves.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to="/companion">{t('modes.states.install', 'Get Xpeed Companion')}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/virtual/companion">{t('modes.states.connect', 'Connect it to your account')}</Link>
        </Button>
      </div>
    </div>
  );
}

/** The server could not give what was asked for: signed out, or an outage. Different from an empty list, and says what to do. */
export function ErrorPanel({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying?: boolean }) {
  const { t } = useTranslation();
  const signedOut = isSignedOut(error);
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" data-testid="sim-error">
      <p className="flex items-center gap-2 font-medium">
        <CloudOff className="h-4 w-4 shrink-0" />
        {signedOut ? t('modes.states.signedOut', 'You are signed out. Sign in again to see your laps.') : t('modes.states.failed', 'Your laps could not be loaded. The server or your connection is not answering.')}
      </p>
      {signedOut ? (
        <Button asChild size="sm">
          <Link to="/login">{t('modes.states.signIn', 'Sign in')}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {t('modes.states.retry', 'Try again')}
        </Button>
      )}
    </div>
  );
}

/** Shown above data that is on screen although the last read failed: what is shown is old, and a retry is one click away. */
export function StaleBadge({ updatedAt, onRetry, retrying }: { updatedAt: number; onRetry: () => void; retrying?: boolean }) {
  const { t } = useTranslation();
  const age = useAge();
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-2 text-xs" data-testid="sim-stale">
      <Badge variant="secondary" className="gap-1">
        <CloudOff className="h-3 w-3" /> {t('modes.states.stale', 'Showing saved data')}
      </Badge>
      <span className="text-muted-foreground">{t('modes.states.staleAge', 'Last updated {{when}}. The server is not answering.', { when: age(updatedAt) })}</span>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onRetry} disabled={retrying}>
        {retrying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
        {t('modes.states.retry', 'Try again')}
      </Button>
    </div>
  );
}

interface GateQuery {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

/**
 * The honest states of a screen that reads the server: a skeleton while the first read runs; an error (signed out, or an outage
 * with a retry) when there is nothing to show; the old data with a "showing saved data" badge when a later read failed; the
 * invitation to connect Xpeed Companion when the answer is an empty list; otherwise the data.
 */
export function QueryGate({ query, empty, emptyNode, skeleton, children }: {
  query: GateQuery;
  /** The read worked and there is nothing in it. */
  empty: boolean;
  emptyNode?: ReactNode;
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  const hasData = !query.isPending && (!query.isError || query.dataUpdatedAt > 0);
  if (query.isPending && !query.isError) return <>{skeleton ?? <ListSkeleton />}</>;
  if (query.isError && !hasData) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  return (
    <>
      {query.isError &&
        (isSignedOut(query.error) ? (
          <div className="mb-3"><ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /></div>
        ) : (
          <div className="mb-3"><StaleBadge updatedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} retrying={query.isFetching} /></div>
        ))}
      {empty ? (emptyNode ?? <CompanionInvite />) : children}
    </>
  );
}

/** The "Load more" button of a paged list: there is no hidden paging, the person asks for the next page. */
export function LoadMore({ hasNextPage, isFetchingNextPage, onClick }: { hasNextPage: boolean; isFetchingNextPage: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  if (!hasNextPage) return null;
  return (
    <div className="flex justify-center pt-2">
      <Button variant="outline" onClick={onClick} disabled={isFetchingNextPage} data-testid="load-more">
        {isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('modes.states.loadMore', 'Load more')}
      </Button>
    </div>
  );
}
