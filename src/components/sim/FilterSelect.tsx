import { useId } from 'react';
import { OptionSelect } from '@/components/ui/option-select';

/**
 * A labelled drop-down with an "all" first entry (the app's Radix select, so it looks the same everywhere). By default the label is above it;
 * `inline` puts the label inside the control, on the left, for a compact toolbar.
 */
export function FilterSelect({ label, value, onChange, options, allLabel, disabled, testId, inline }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
  disabled?: boolean;
  testId?: string;
  inline?: boolean;
}) {
  const id = useId();
  if (inline) {
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
        className="min-w-[8.5rem] flex-1 basis-[8.5rem] sm:max-w-[16rem]"
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <label htmlFor={id}>{label}</label>
      <OptionSelect id={id} size="sm" className="h-9 w-full min-w-0 text-sm" value={value} onChange={onChange} options={options} emptyLabel={allLabel} disabled={disabled} data-testid={testId} />
    </div>
  );
}
