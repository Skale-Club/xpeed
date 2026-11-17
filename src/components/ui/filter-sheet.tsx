import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export interface FilterSheetProps {
  /** How many filters are on (shown as a badge on the button; 0 hides it and disables "Clear all"). */
  count: number;
  /** The filter controls, stacked in the sheet body. */
  children: ReactNode;
  onClear: () => void;
  title?: string;
  testId?: string;
}

/**
 * The phone pattern for a filter bar: one "Filters" button (with how many are on) that opens a bottom sheet holding the controls, with
 * "Clear all" and "Show results" at the foot. It does not check the screen size; the screen decides when to use it instead of the inline bar.
 */
export function FilterSheet({ count, children, onClear, title, testId }: FilterSheetProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const heading = title ?? t("ui.filterSheet.title", "Filters");
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="h-10 gap-2" data-testid={testId} data-count={count}>
          <SlidersHorizontal aria-hidden="true" />
          {heading}
          {count > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground" data-testid={testId ? `${testId}-count` : undefined}>
              {count}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="flex max-h-[85vh] flex-col gap-0 rounded-t-xl p-0">
        <SheetHeader className="border-b border-border-subtle px-4 py-3 pr-12">
          <SheetTitle className="text-base">{heading}</SheetTitle>
          <SheetDescription className="sr-only">{t("ui.filterSheet.description", "Choose how to narrow the list.")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">{children}</div>
        <SheetFooter className="flex-row gap-2 border-t border-border-subtle px-4 py-3 sm:space-x-0">
          <Button variant="ghost" className="h-10 flex-1" onClick={onClear} disabled={count === 0} data-testid={testId ? `${testId}-clear` : undefined}>
            {t("ui.filterSheet.clear", "Clear all")}
          </Button>
          <Button className="h-10 flex-1" onClick={() => setOpen(false)} data-testid={testId ? `${testId}-apply` : undefined}>
            {t("ui.filterSheet.apply", "Show results")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
