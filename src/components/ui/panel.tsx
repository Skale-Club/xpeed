import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Something small on the right of the title (a link, a toggle, a count). */
  action?: ReactNode;
  children: ReactNode;
  /** Set false when the content brings its own padding (a table, a list that touches the edges). */
  padded?: boolean;
  className?: string;
  testId?: string;
}

/**
 * The card a block of a screen lives in: small title, optional description and action, then the content. Use it for every titled block;
 * for a titled sub-block inside one, use `PanelSection`.
 */
export function Panel({ title, description, action, children, padded = true, className, testId }: PanelProps) {
  const hasHeader = title != null || description != null || action != null;
  return (
    <Card className={cn("bg-card", className)} data-testid={testId}>
      <CardContent className={cn("space-y-3", padded ? "p-4" : "p-0")}>
        {hasHeader && (
          <div className={cn("flex items-start justify-between gap-2", !padded && "p-4 pb-0")}>
            <div className="min-w-0 space-y-1">
              {title != null && <h3 className="text-sm font-semibold">{title}</h3>}
              {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
            </div>
            {action}
          </div>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

/** A titled sub-block inside a `Panel` (or any card): a small muted heading over its content. */
export function PanelSection({ title, description, children, className, testId }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("space-y-2", className)} data-testid={testId}>
      <div className="space-y-0.5">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
        {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
