import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CloudOff, Loader2, RefreshCw, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** A button or link that gets the person out of the empty state (add the first item, clear the filters). */
  action?: ReactNode;
  /** Less padding, for use inside a panel. */
  compact?: boolean;
  className?: string;
  testId?: string;
}

/** What a list or block says when there is nothing in it: an icon, what is missing, why or what to do, and the way out. */
export function EmptyState({ icon: Icon, title, description, action, compact = false, className, testId }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "gap-2 px-3 py-6" : "gap-3 px-4 py-12", className)} data-testid={testId}>
      {Icon && (
        <span className={cn("inline-flex items-center justify-center rounded-full bg-surface-raised text-muted-foreground", compact ? "h-10 w-10" : "h-12 w-12")}>
          <Icon className={compact ? "h-5 w-5" : "h-6 w-6"} aria-hidden="true" />
        </span>
      )}
      <div className="max-w-sm space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Adds the "Try again" button. */
  onRetry?: () => void;
  /** Disables the retry button and spins its icon while a retry runs. */
  retrying?: boolean;
  /** Another way out next to (or instead of) the retry, such as "Sign in". */
  action?: ReactNode;
  className?: string;
  testId?: string;
}

/** The read failed and there is nothing to show: says so in plain words, in the critical tone, with a retry. Different from an empty list. */
export function ErrorState({ title, description, onRetry, retrying = false, action, className, testId }: ErrorStateProps) {
  const { t } = useTranslation();
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-3 rounded-lg border border-critical-line bg-critical-soft px-4 py-8 text-center", className)} data-testid={testId}>
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-critical-soft text-critical">
        <CloudOff className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="max-w-sm space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title ?? t("ui.states.errorTitle", "Something went wrong")}</h3>
        <p className="text-xs text-muted-foreground">{description ?? t("ui.states.errorDescription", "This could not be loaded. Try again in a moment.")}</p>
      </div>
      {(onRetry || action) && (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
              {retrying ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {t("ui.states.retry", "Try again")}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

export interface LoadingStateProps {
  variant?: "spinner" | "list" | "cards";
  /** How many placeholder rows or cards (defaults: 4 rows, 6 cards). */
  rows?: number;
  /** The accessible name of the loading area. */
  label?: string;
  className?: string;
  testId?: string;
}

/** The first read is running: a spinner for a block, or placeholders shaped like the rows or cards that are coming so nothing jumps. */
export function LoadingState({ variant = "spinner", rows, label, className, testId }: LoadingStateProps) {
  const { t } = useTranslation();
  const name = label ?? t("ui.states.loading", "Loading…");
  if (variant === "spinner") {
    return (
      <div role="status" className={cn("flex items-center justify-center py-8 text-muted-foreground", className)} data-testid={testId}>
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span className="sr-only">{name}</span>
      </div>
    );
  }
  const count = rows ?? (variant === "cards" ? 6 : 4);
  return (
    <div
      role="status"
      aria-label={name}
      className={cn(variant === "cards" ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" : "space-y-3", className)}
      data-testid={testId}
    >
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn("w-full rounded-lg", variant === "cards" ? "h-28" : "h-20")} />
      ))}
    </div>
  );
}
