import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";

/** The part of a react-query result the gate reads (any `useQuery` result fits). */
export interface GateQuery {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

export interface QueryGateProps {
  query: GateQuery;
  /** The read worked and there is nothing in it. */
  empty: boolean;
  /** What to show for an empty answer; a plain `EmptyState` when omitted. */
  emptyNode?: ReactNode;
  /** What to show during the first read; a `LoadingState` list when omitted. */
  skeleton?: ReactNode;
  /** Says whether an error means "signed out" (then it is shown with `signInAction` and kept above old data). */
  isSignedOut?: (error: unknown) => boolean;
  signInAction?: ReactNode;
  errorTitle?: ReactNode;
  errorDescription?: ReactNode;
  children: ReactNode;
}

/**
 * The honest states of a screen that reads the server: placeholders during the first read; an error with a retry when there is
 * nothing to show; the old data under a "showing saved data" notice when a later read failed; the empty state for an empty
 * answer; otherwise the data.
 */
export function QueryGate({ query, empty, emptyNode, skeleton, isSignedOut, signInAction, errorTitle, errorDescription, children }: QueryGateProps) {
  const { t } = useTranslation();
  const retry = () => void query.refetch();
  const signedOut = query.isError && isSignedOut?.(query.error) === true;
  const errorState = (
    <ErrorState
      title={signedOut ? t("ui.queryGate.signedOutTitle", "You are signed out") : errorTitle}
      description={signedOut ? t("ui.queryGate.signedOutDescription", "Sign in again to continue.") : errorDescription}
      onRetry={signedOut && signInAction ? undefined : retry}
      retrying={query.isFetching}
      action={signedOut ? signInAction : undefined}
      testId="query-gate-error"
    />
  );

  const hasData = !query.isPending && (!query.isError || query.dataUpdatedAt > 0);
  if (query.isPending && !query.isError) return <>{skeleton ?? <LoadingState variant="list" />}</>;
  if (query.isError && !hasData) return errorState;
  return (
    <>
      {query.isError &&
        (signedOut ? (
          <div className="mb-3">{errorState}</div>
        ) : (
          <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised p-2 text-xs" data-testid="query-gate-stale">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <CloudOff className="h-3.5 w-3.5" aria-hidden="true" /> {t("ui.queryGate.stale", "Showing saved data")}
            </span>
            <span className="text-muted-foreground">{t("ui.queryGate.staleHint", "Could not refresh.")}</span>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={retry} disabled={query.isFetching}>
              {query.isFetching ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {t("ui.states.retry", "Try again")}
            </Button>
          </div>
        ))}
      {empty ? (emptyNode ?? <EmptyState title={t("ui.queryGate.emptyTitle", "Nothing here yet")} />) : children}
    </>
  );
}
