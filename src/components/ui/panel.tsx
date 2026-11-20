import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { accentColor, type Accent } from "@/lib/chart-theme";
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
  /**
   * `default` is today's panel. `feature` is the Dashboards 2027 panel (proposed 2026-11-20, pending the owner's approval on /admin/design):
   * 16 px corner, 20 px inside, the title with an optional accent icon, a chart legend (`ChartLegend`) as the `action`.
   */
  variant?: "default" | "feature";
  /** `feature`: a small icon before the title, in the panel's accent. */
  icon?: LucideIcon;
  accent?: Accent;
}

/**
 * The card a block of a screen lives in: small title, optional description and action, then the content. Use it for every titled block;
 * for a titled sub-block inside one, use `PanelSection`.
 */
export function Panel({ title, description, action, children, padded = true, className, testId, variant = "default", icon: Icon, accent }: PanelProps) {
  const hasHeader = title != null || description != null || action != null;
  if (variant === "feature") {
    return (
      <Card className={cn("rounded-panel bg-card", className)} data-testid={testId} data-variant="feature">
        <div className={cn("space-y-4", padded ? "p-5" : "p-0")}>
          {hasHeader && (
            <div className={cn("flex items-start justify-between gap-3", !padded && "p-5 pb-0")}>
              <div className="flex min-w-0 items-start gap-2.5">
                {Icon && (
                  <span
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground"
                    style={accent ? { background: accentColor(accent, 0.14), color: accentColor(accent) } : undefined}
                    aria-hidden="true"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                )}
                <div className="min-w-0 space-y-0.5">
                  {title != null && <h3 className="text-sm font-semibold leading-snug">{title}</h3>}
                  {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
                </div>
              </div>
              {action}
            </div>
          )}
          {children}
        </div>
      </Card>
    );
  }
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
