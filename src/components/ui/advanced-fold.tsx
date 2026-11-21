import { useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

import { advancedOpenByDefault, rememberAdvanced } from "@/lib/advanced";
import { cn } from "@/lib/utils";

/**
 * The second level of a screen (owner rule, 2026-11-21: XPD-D-SIMPLE-FIRST). A screen shows first what anybody understands (the best lap,
 * the track, where the time goes, in plain words); the detail an enthusiast wants (sectors, corner tables, telemetry) sits in this fold,
 * under it, closed until asked for. Opening or closing one is remembered for all of them, and "Advanced tools" in Settings opens them from
 * the start. What is inside stays in the page while closed, so a link or a button elsewhere can still point at it.
 */
export function AdvancedFold({ title, hint, children, testId, className }: { title: string; hint?: string; children: ReactNode; testId?: string; className?: string }) {
  const [open, setOpen] = useState(advancedOpenByDefault);
  return (
    <details
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        rememberAdvanced(next);
      }}
      className={cn("group/fold rounded-panel border border-border/70 bg-card/40", className)}
      data-testid={testId}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-panel px-4 py-3 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/fold:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-border/70 p-3 sm:p-4">{children}</div>
    </details>
  );
}
