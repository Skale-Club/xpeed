import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

import { FILTER_CELL, FILTER_WIDE_CELL } from "@/components/ui/filter-bar";
import { OptionSelect } from "@/components/ui/option-select";
import { cn } from "@/lib/utils";

/**
 * A drop-down of a filter bar, with an "all" first entry (the app's Radix select). Always the compact one: h-8, text-xs, the name inside the
 * control on the left and the value on the right, so a bar of them is one row. `className` sets the width on a wide screen (a phone gets two to a row).
 */
export function FilterSelect({ label, value, onChange, options, allLabel, disabled, testId, className }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  /** The label of the first entry, whose value is '' (nothing filtered). */
  allLabel: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <OptionSelect
      size="sm"
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      emptyLabel={allLabel}
      disabled={disabled}
      data-testid={testId}
      className={cn(FILTER_CELL, "sm:w-32", className)}
    />
  );
}

/**
 * A search box for a filter bar: small (h-8, text-xs) like the drop-downs next to it, the magnifier inside and a clear button once there is text.
 * A whole row on a phone, a fixed width on a wide screen; `className` changes that width. The label is its accessible name.
 */
export function SearchField({ label, value, onChange, placeholder, testId, className }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span className={cn(FILTER_WIDE_CELL, "relative block sm:w-52", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        role="searchbox"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? label}
        autoComplete="off"
        className="h-8 w-full min-w-0 rounded-lg border border-input bg-background/60 py-0 pl-8 pr-8 text-xs [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid={testId}
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("ui.filter.clearSearch", "Clear search")}
          className="absolute right-0.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
