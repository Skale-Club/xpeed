import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "brand" | "success" | "warn" | "critical" | "info";

const TONE: Record<StatTone, string> = {
  default: "",
  brand: "text-brand",
  success: "text-success",
  warn: "text-warn",
  critical: "text-critical",
  info: "text-info",
};

const TREND_ICON = { up: ArrowUp, down: ArrowDown, flat: Minus } as const;
const MEANING: Record<"good" | "bad" | "neutral", string> = { good: "text-success", bad: "text-critical", neutral: "text-muted-foreground" };

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** The quiet line under the value. */
  hint?: ReactNode;
  icon?: LucideIcon;
  /** Colours the value. */
  tone?: StatTone;
  /** `label` is the sentence for screen readers and the tooltip ("12% more than last week"); `meaning` colours the arrow (more driving is neutral). */
  trend?: { direction: "up" | "down" | "flat"; label: string; meaning?: "good" | "bad" | "neutral" };
  /** Anything small at the bottom (a sparkline). */
  footer?: ReactNode;
  testId?: string;
}

/**
 * One number of a screen: small label, big tabular value, a quiet hint and an optional trend. Use it inside a `StatGrid` for a row of KPIs;
 * the tile is a list item so the grid reads as a list. `testId` is the tile's; the value is `${testId}-value`.
 */
export function StatTile({ label, value, hint, icon: Icon, tone = "default", trend, footer, testId }: StatTileProps) {
  const TrendIcon = trend ? TREND_ICON[trend.direction] : null;
  return (
    <li className="min-w-0">
      <Card className="h-full space-y-1.5 bg-card p-3" data-testid={testId}>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </div>
        <p className={cn("truncate font-mono text-xl font-semibold leading-tight tabular-nums", TONE[tone])} data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </p>
        {(hint != null || trend) && (
          <div className="flex min-h-4 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {trend && TrendIcon && (
              <span
                className={cn("inline-flex items-center gap-0.5", MEANING[trend.meaning ?? "neutral"])}
                data-trend={trend.direction}
                title={trend.label}
                data-testid={testId ? `${testId}-trend` : undefined}
              >
                <TrendIcon className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">{trend.label}</span>
              </span>
            )}
            {hint != null && <span className="min-w-0 truncate">{hint}</span>}
          </div>
        )}
        {footer}
      </Card>
    </li>
  );
}

type Cols = { base?: 1 | 2; sm?: 2 | 3; lg?: 3 | 4 | 6 };

// Full class names so Tailwind can see them.
const BASE = { 1: "grid-cols-1", 2: "grid-cols-2" } as const;
const SM = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" } as const;
const LG = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 6: "lg:grid-cols-6" } as const;

/** The grid `StatTile`s sit in: 2 across on a phone, 3 from `sm`, 6 from `lg` unless `columns` says otherwise. */
export function StatGrid({ children, columns, className, testId }: { children: ReactNode; columns?: Cols; className?: string; testId?: string }) {
  const { base = 2, sm = 3, lg = 6 } = columns ?? {};
  return (
    <ul className={cn("grid gap-3", BASE[base], SM[sm], LG[lg], className)} data-testid={testId}>
      {children}
    </ul>
  );
}
