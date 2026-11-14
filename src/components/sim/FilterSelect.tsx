import { OptionSelect } from '@/components/ui/option-select';
import { FILTER_CELL } from '@/components/ui/filter-bar';
import { cn } from '@/lib/utils';

/**
 * A drop-down of a filter toolbar, with an "all" first entry (the app's Radix select, so it looks the same everywhere). It is always the compact one:
 * small (h-8, text-xs), the name inside the control on the left and the value on the right, so a bar of them is one row. `className` sets the width
 * on a wide screen (a phone gets two to a row).
 */
export function FilterSelect({ label, value, onChange, options, allLabel, disabled, testId, className }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
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
      className={cn(FILTER_CELL, 'sm:w-32', className)}
    />
  );
}
