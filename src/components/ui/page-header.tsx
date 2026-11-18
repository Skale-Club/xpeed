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
}

/**
 * The top of a page: optional back link, icon + title, a sentence under it and the page's actions. Use it once per screen, as its `h2`;
 * the title row wraps so actions never squeeze the title on a phone. Needs a react-router context only when `back` is set.
 */
export function PageHeader({ icon: Icon, title, description, actions, back, className, testId }: PageHeaderProps) {
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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="flex min-w-0 items-center gap-2 text-xl font-bold">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />}
          <span className="min-w-0">{title}</span>
        </h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="break-words text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}
