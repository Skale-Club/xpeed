import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the right of the title; on a narrow screen they wrap below it. */
  actions?: ReactNode;
  /** A small link above the title that goes back to the parent screen. */
  back?: { to: string; label: string };
  className?: string;
  testId?: string;
  /** A small uppercase line above the title: where you are and the period ("Overview · last 7 days"). */
  eyebrow?: ReactNode;
  /**
   * `default` is today's header. `lg` is the Dashboards 2027 header (proposed 2026-11-20, pending the owner's approval on /admin/design):
   * a 30 px title, the description as a one-sentence summary, actions aligned to the title's foot.
   */
  size?: "default" | "lg";
}

/**
 * The top of a page: optional back link, icon + title, a sentence under it and the page's actions. Use it once per screen, as its `h2`;
 * the title row wraps so actions never squeeze the title on a phone. Needs a react-router context only when `back` is set.
 */
export function PageHeader({ icon: Icon, title, description, actions, back, className, testId, eyebrow, size = "default" }: PageHeaderProps) {
  const lg = size === "lg";
  return (
    <header className={cn("space-y-1", className)} data-testid={testId}>
      {back && (
        <Link
          to={back.to}
          className="-ml-1 inline-flex h-8 items-center gap-0.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      {lg ? (
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 space-y-1.5">
            {eyebrow && <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground" data-testid={testId ? `${testId}-eyebrow` : undefined}>{eyebrow}</p>}
            <h2 className="flex min-w-0 items-center gap-2.5 text-[30px] font-semibold leading-tight tracking-[-0.025em]">
              {Icon && <Icon className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />}
              <span className="min-w-0">{title}</span>
            </h2>
            {description && <p className="break-words text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      ) : (
        <>
          {eyebrow && <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground" data-testid={testId ? `${testId}-eyebrow` : undefined}>{eyebrow}</p>}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="flex min-w-0 items-center gap-2 text-xl font-bold">
              {Icon && <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />}
              <span className="min-w-0">{title}</span>
            </h2>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
          {description && <p className="break-words text-sm text-muted-foreground">{description}</p>}
        </>
      )}
    </header>
  );
}
