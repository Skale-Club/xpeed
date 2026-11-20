import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

export type TrendMeaning = "good" | "bad" | "neutral";

const MEANING: Record<TrendMeaning, string> = {
  good: "bg-success/15 text-success",
  bad: "bg-critical/15 text-critical",
  neutral: "bg-foreground/[0.07] text-secondary-foreground",
};
const ICON = { up: ArrowUp, down: ArrowDown, flat: Minus } as const;

export interface TrendChipProps {
  direction: "up" | "down" | "flat";
  /** What a screen reader says and the tooltip shows ("500% more than the period before"). */
  label: string;
  /** The short visible text ("500%"); without it the chip is only the arrow. */
  text?: string;
  /** Colours the chip: up is not always good (more fuel used is bad, more driving is neutral). */
  meaning?: TrendMeaning;
  testId?: string;
}

/**
 * A change against the period before, as a small pill: arrow, short text, colour by meaning (Dashboards 2027, proposed 2026-11-20).
 * The sentence for screen readers is `label`; the visible text is hidden from them so it is not read twice.
 */
export function TrendChip({ direction, label, text, meaning = "neutral", testId }: TrendChipProps) {
  const Icon = ICON[direction];
  return (
    <span
      className={cn("inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-2xs font-semibold tabular-nums", MEANING[meaning])}
      title={label}
      data-trend={direction}
      data-meaning={meaning}
      data-testid={testId}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {text && <span aria-hidden="true">{text}</span>}
      <span className="sr-only">{label}</span>
    </span>
  );
}
