import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { cn } from "@/lib/utils";

export interface PaginationProps {
  /** The current page, 1-based. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** With `pageSize`, adds "x–y of total". */
  total?: number;
  pageSize?: number;
  /** Adds a drop-down to jump to any page (only when there is more than one). */
  showJump?: boolean;
  className?: string;
  testId?: string;
}

/**
 * Previous / Next with "Page x of y" between them, for a list split in pages the person moves through. The buttons are h-10 on a phone
 * (their text hides below `sm`, the icon stays and the name is kept for screen readers). For "ask for the next page" lists use `LoadMore`.
 */
export function Pagination({ page, pageCount, onPageChange, total, pageSize, showJump = false, className, testId }: PaginationProps) {
  const { t } = useTranslation();
  const last = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), last);
  const previous = t("ui.pagination.previous", "Previous");
  const next = t("ui.pagination.next", "Next");
  const range =
    total != null && pageSize != null && total > 0
      ? t("ui.pagination.range", "{{from}}–{{to}} of {{total}}", { from: (current - 1) * pageSize + 1, to: Math.min(current * pageSize, total), total })
      : null;
  const button = "h-10 sm:h-9";

  return (
    <nav aria-label={t("ui.pagination.label", "Pagination")} className={cn("flex flex-wrap items-center justify-between gap-2", className)} data-testid={testId}>
      <Button variant="outline" size="sm" className={button} disabled={current <= 1} onClick={() => onPageChange(current - 1)} aria-label={previous} data-testid={testId ? `${testId}-previous` : undefined}>
        <ChevronLeft aria-hidden="true" />
        <span className="hidden sm:inline">{previous}</span>
      </Button>
      <div className="flex min-w-0 flex-col items-center gap-0.5 text-center sm:flex-row sm:gap-3">
        <span className="text-sm text-foreground" data-testid={testId ? `${testId}-status` : undefined}>
          {t("ui.pagination.status", "Page {{page}} of {{count}}", { page: current, count: last })}
        </span>
        {range && <span className="text-xs text-muted-foreground">{range}</span>}
        {showJump && last > 1 && (
          <OptionSelect
            size="sm"
            aria-label={t("ui.pagination.jump", "Go to page")}
            className="w-auto min-w-[6rem]"
            value={String(current)}
            onChange={(value) => onPageChange(Number(value))}
            options={Array.from({ length: last }, (_, index) => ({ value: String(index + 1), label: t("ui.pagination.option", "Page {{page}}", { page: index + 1 }) }))}
            data-testid={testId ? `${testId}-jump` : undefined}
          />
        )}
      </div>
      <Button variant="outline" size="sm" className={button} disabled={current >= last} onClick={() => onPageChange(current + 1)} aria-label={next} data-testid={testId ? `${testId}-next` : undefined}>
        <span className="hidden sm:inline">{next}</span>
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
