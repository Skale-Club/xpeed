import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** `md` (h-10) is the phone-friendly default; `sm` (h-8) fits dense toolbars. */
  size?: "sm" | "md";
  /** Stretches the control and shares the width between the options. */
  fullWidth?: boolean;
  "aria-label": string;
  /** Marks the group as busy (the choice is being applied). */
  busy?: boolean;
  testId?: string;
}

const SIZE = {
  sm: { box: "h-8", item: "px-2.5 text-xs", icon: "h-3.5 w-3.5" },
  md: { box: "h-10", item: "px-3 text-sm", icon: "h-4 w-4" },
} as const;

/**
 * A short, mutually exclusive choice shown as a row of buttons (a period, a mode, a view). It is a radio group: one tab stop,
 * the arrow keys move the choice, Home and End jump to the ends. Use `Tabs` instead when the choice swaps a block of content.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  "aria-label": ariaLabel,
  busy,
  testId,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const found = options.findIndex((option) => option.value === value);
  const tabStop = found === -1 ? 0 : found;
  const look = SIZE[size];

  const move = (event: KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      className={cn("rounded-lg border border-border-subtle bg-muted/40 p-0.5", look.box, fullWidth ? "flex w-full" : "inline-flex")}
      data-testid={testId}
    >
      {options.map((option, index) => {
        const selected = index === found;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            data-testid={testId ? `${testId}-${option.value}` : undefined}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              look.item,
              fullWidth && "flex-1",
              selected ? "bg-background text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className={cn("shrink-0", look.icon)} aria-hidden="true" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
