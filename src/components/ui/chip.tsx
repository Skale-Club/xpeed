import type { ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const SIZE = { sm: "h-7 text-xs", md: "h-8 text-sm" } as const;

export interface ChipProps {
  children: ReactNode;
  /** Highlights the chip (a filter that is on). */
  selected?: boolean;
  /** Makes the chip a toggle button (`aria-pressed` follows `selected`). */
  onClick?: () => void;
  /** Adds an X button that removes the chip (an applied filter). */
  onRemove?: () => void;
  /** The accessible name of the X button, e.g. "Remove the filter: Monza". */
  removeLabel?: string;
  icon?: ReactNode;
  size?: keyof typeof SIZE;
  className?: string;
  testId?: string;
}

/**
 * A rounded pill for a filter, a tag or a choice. Pass `onClick` for a toggle (`selected` shows its state), `onRemove` for an applied filter
 * the user can clear, neither for a plain label. `md` (h-8) is the phone-friendly default; `sm` fits dense toolbars.
 */
export function Chip({ children, selected = false, onClick, onRemove, removeLabel, icon, size = "md", className, testId }: ChipProps) {
  const shell = cn(
    "inline-flex max-w-full items-center rounded-full border font-medium transition-colors",
    SIZE[size],
    selected ? "border-primary bg-primary/10 text-foreground" : "border-border bg-muted/40 text-muted-foreground",
  );
  const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const body = (
    <>
      {icon && (
        <span className="mr-1.5 inline-flex shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="truncate">{children}</span>
    </>
  );

  const main = onClick ? (
    <button type="button" aria-pressed={selected} onClick={onClick} className={cn("inline-flex h-full min-w-0 items-center rounded-full px-3 hover:text-foreground", focus)}>
      {body}
    </button>
  ) : (
    <span className="inline-flex h-full min-w-0 items-center px-3">{body}</span>
  );

  return (
    <span className={cn(shell, onClick && !selected && "hover:bg-muted", className)} data-testid={testId} data-selected={selected ? "true" : undefined}>
      {main}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? "Remove"}
          className={cn("-ml-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:text-foreground", focus)}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
