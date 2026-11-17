import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warn" | "critical" | "info" | "neutral";

const TONE_VARIANT: Record<StatusTone, NonNullable<BadgeProps["variant"]>> = {
  success: "success",
  warn: "warn",
  critical: "critical",
  info: "info",
  neutral: "muted",
};

/**
 * A state as a soft badge with a small dot (online, failed, pending, ...). Use it wherever a row or card says "what state is this in";
 * use plain `Badge` for labels and categories that are not a state.
 */
export function StatusBadge({ tone, children, dot = true, className, ...props }: Omit<BadgeProps, "variant"> & { tone: StatusTone; children: ReactNode; dot?: boolean }) {
  return (
    <Badge variant={TONE_VARIANT[tone]} className={cn("gap-1.5", className)} data-tone={tone} {...props}>
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" data-testid="status-dot" />}
      {children}
    </Badge>
  );
}
