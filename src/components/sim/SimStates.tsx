import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { QueryGate as UiQueryGate, type GateQuery } from '@/components/ui/query-gate';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { isSignedOut } from '@/lib/sim/v1-client';
import { useAge } from './use-age';

/** A placeholder shaped like the rows a list is about to show: the shared loading state. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation();
  return <LoadingState variant="list" rows={rows} label={t('common.loading', 'Loading…')} testId="sim-skeleton" />;
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
    <ErrorState
      title={signedOut ? t('modes.states.signedOut', 'You are signed out. Sign in again to see your laps.') : t('modes.states.failed', 'Your laps could not be loaded. Try again in a moment.')}
      description=""
      onRetry={signedOut ? undefined : onRetry}
      retrying={retrying}
      action={signedOut ? <Button asChild size="sm"><Link to="/login">{t('modes.states.signIn', 'Sign in')}</Link></Button> : undefined}
      testId="sim-error"
    />
  );
}

/**
 * The honest states of a screen that reads the server: the shared `QueryGate` with the Virtual words and test ids: a skeleton while the first read
 * runs; an error (signed out, or an outage with a retry) when there is nothing to show; the old data with a "showing saved data" notice and its
 * age when a later read failed; the invitation to connect Xpeed Companion when the answer is an empty list; otherwise the data.
 */
export function QueryGate({ query, empty, emptyNode, skeleton, children }: {
  query: GateQuery;
  /** The read worked and there is nothing in it. */
  empty: boolean;
  emptyNode?: ReactNode;
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const age = useAge();
  return (
    <UiQueryGate
      query={query}
      empty={empty}
      emptyNode={emptyNode ?? <CompanionInvite />}
      skeleton={skeleton ?? <ListSkeleton />}
      isSignedOut={isSignedOut}
      signInAction={<Button asChild size="sm"><Link to="/login">{t('modes.states.signIn', 'Sign in')}</Link></Button>}
      errorTitle={t('modes.states.failed', 'Your laps could not be loaded. Try again in a moment.')}
      errorDescription=""
      signedOutTitle={t('modes.states.signedOut', 'You are signed out. Sign in again to see your laps.')}
      signedOutDescription=""
      staleHint={t('modes.states.staleAge', 'Last updated {{when}}. Could not refresh.', { when: age(query.dataUpdatedAt) })}
      errorTestId="sim-error"
      staleTestId="sim-stale"
    >
      {children}
    </UiQueryGate>
  );
}

/** The "Load more" button of a paged list: the shared one. */
export { LoadMore } from '@/components/ui/load-more';
