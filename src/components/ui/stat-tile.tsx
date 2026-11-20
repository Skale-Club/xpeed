import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { Card } from "@/components/ui/card";
import { accentColor, type Accent } from "@/lib/chart-theme";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendChip } from "@/components/ui/trend-chip";
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
  /**
   * `label` is the sentence for screen readers and the tooltip ("12% more than last week"); `meaning` colours the arrow (more driving is neutral).
   * `text` is the short visible change ("12%"), shown in a chip by the `feature` and `hero` sizes.
   */
  trend?: { direction: "up" | "down" | "flat"; label: string; meaning?: "good" | "bad" | "neutral"; text?: string };
  /**
   * `compact` is today's tile. `feature` and `hero` are the Dashboards 2027 tiles (proposed 2026-11-20, pending the owner's approval on
   * /admin/design): 20 px inside, an uppercase label, the number in the display face; `hero` is the one big number a screen opens with.
   */
  size?: "compact" | "feature" | "hero";
  /** `feature` / `hero`: the tile's colour (icon, glow in the corner, the sparkline you pass with `accentColor`). Yellow is for records only. */
  accent?: Accent;
  /** A small unit after the value ("km", "min"), quieter than the number. */
  unit?: ReactNode;
  /** `feature` / `hero`: something small before the hint, in its row (a change chip a screen draws itself). */
  badge?: ReactNode;
  /** Classes for the tile's list item (a column or row span in a bento). */
  itemClassName?: string;
  /** Anything small at the bottom (a sparkline). */
  footer?: ReactNode;
  /** What the number means, as a tooltip on the tile. */
  title?: string;
  /** The number is still being worked out: a skeleton in place of the value, never a zero. */
  loading?: boolean;
  testId?: string;
  /** Overrides the value's test id (default `${testId}-value`); the skeleton is `${valueTestId}-loading`. */
  valueTestId?: string;
  /** Overrides the hint line's test id (default `${testId}-sub`). */
  subTestId?: string;
}

/**
 * One number of a screen: small label, big tabular value, a quiet hint and an optional trend. Use it inside a `StatGrid` for a row of KPIs;
 * the tile is a list item so the grid reads as a list. `testId` is the tile's; the value is `${testId}-value`.
 */
export function StatTile(props: StatTileProps) {
  if (props.size === "feature" || props.size === "hero") return <FeatureTile {...props} />;
  return <CompactTile {...props} />;
}

function CompactTile({ label, value, hint, icon: Icon, tone = "default", trend, footer, title, loading = false, testId, valueTestId, subTestId, unit }: StatTileProps) {
  const valueId = valueTestId ?? (testId ? `${testId}-value` : undefined);
  const TrendIcon = trend ? TREND_ICON[trend.direction] : null;
  return (
    <li className="min-w-0">
      <Card className="h-full space-y-1.5 bg-card p-3" data-testid={testId} title={title}>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </div>
        {loading ? (
          <Skeleton className="h-7 w-20" data-testid={valueId ? `${valueId}-loading` : undefined} />
        ) : (
          <p className={cn("truncate font-mono text-xl font-semibold leading-tight tabular-nums", TONE[tone])} data-testid={valueId}>
            {value}
            {unit != null && <span className="ml-1 text-xs font-medium text-muted-foreground">{unit}</span>}
          </p>
        )}
        {!loading && (hint != null || trend) && (
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
            {hint != null && (
              <span className="min-w-0 truncate" data-testid={subTestId ?? (testId ? `${testId}-sub` : undefined)}>
                {hint}
              </span>
            )}
          </div>
        )}
        {footer}
      </Card>
    </li>
  );
}

/** The Dashboards 2027 tile: accent icon and corner glow, uppercase label, the number in the display face, the change as a chip, a sparkline at the foot. */
function FeatureTile({ label, value, hint, icon: Icon, tone = "default", trend, footer, title, loading = false, testId, valueTestId, subTestId, unit, size, accent, badge, itemClassName }: StatTileProps) {
  const hero = size === "hero";
  const valueId = valueTestId ?? (testId ? `${testId}-value` : undefined);
  return (
    <li className={cn("min-w-0", hero && "sm:row-span-2", itemClassName)}>
      <Card
        className={cn("relative flex h-full flex-col overflow-hidden rounded-panel bg-card", hero ? "gap-2 px-6 pt-6" : "gap-1.5 p-5", hero && !footer && "pb-6")}
        data-testid={testId}
        data-size={size}
        data-accent={accent}
        title={title}
      >
        {accent && (
          <span
            className="pointer-events-none absolute inset-0"
            style={{ background: `radial-gradient(120% 70% at 100% 0%, ${accentColor(accent, hero ? 0.12 : 0.08)}, transparent 60%)` }}
            aria-hidden="true"
          />
        )}
        <div className="relative flex items-center justify-between gap-2">
          <p className="truncate text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
          {Icon && (
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground"
              style={accent ? { background: accentColor(accent, 0.14), color: accentColor(accent) } : undefined}
              aria-hidden="true"
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
        {loading ? (
          <Skeleton className={hero ? "h-14 w-28" : "h-8 w-20"} data-testid={valueId ? `${valueId}-loading` : undefined} />
        ) : (
          <p className={cn("relative truncate font-display font-semibold leading-none tracking-tight tabular-nums", hero ? "text-[56px]" : "text-[30px]", TONE[tone])} data-testid={valueId}>
            {value}
            {unit != null && <span className="ml-1.5 align-baseline text-[0.45em] font-medium tracking-normal text-muted-foreground">{unit}</span>}
          </p>
        )}
        {!loading && (hint != null || trend || badge != null) && (
          <div className="relative flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {badge}
            {trend && <TrendChip direction={trend.direction} label={trend.label} text={trend.text} meaning={trend.meaning} testId={testId ? `${testId}-trend` : undefined} />}
            {hint != null && <span className="min-w-0 truncate" data-testid={subTestId ?? (testId ? `${testId}-sub` : undefined)}>{hint}</span>}
          </div>
        )}
        {footer && <div className={cn("relative mt-auto", hero ? "-mx-6 pt-3" : "pt-2")}>{footer}</div>}
      </Card>
    </li>
  );
}

type Cols = { base?: 1 | 2; sm?: 2 | 3 | 4; lg?: 3 | 4 | 6 | null; xl?: 4 | 6 };

// Full class names so Tailwind can see them.
const BASE = { 1: "grid-cols-1", 2: "grid-cols-2" } as const;
const SM = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" } as const;
const LG = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 6: "lg:grid-cols-6" } as const;
const XL = { 4: "xl:grid-cols-4", 6: "xl:grid-cols-6" } as const;

/** The grid `StatTile`s sit in: 2 across on a phone, 3 from `sm`, 6 from `lg` (or `xl`) unless `columns` says otherwise. */
export function StatGrid({ children, columns, className, testId }: { children: ReactNode; columns?: Cols; className?: string; testId?: string }) {
  // `lg: null` (or an `xl` without an `lg`) leaves the lg step out.
  const { base = 2, sm = 3, xl } = columns ?? {};
  const lg = columns && "lg" in columns ? columns.lg : xl ? null : 6;
  return (
    <ul className={cn("grid gap-3", BASE[base], SM[sm], lg && LG[lg], xl && XL[xl], className)} data-testid={testId}>
      {children}
    </ul>
  );
}

/**
 * Dashboards 2027 (proposed 2026-11-20): the opening row of a dashboard. One `hero` tile on the left, two rows of `feature` tiles beside it;
 * one column on a phone, the hero on its own row on a tablet.
 */
export function StatBento({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <ul className={cn("grid gap-3.5 sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr]", className)} data-testid={testId}>
      {children}
    </ul>
  );
}
