/** A labelled drop-down with an "all" first entry. Native, so it works the same on a phone. */
export function FilterSelect({ label, value, onChange, options, allLabel, disabled, testId }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      >
        <option value="">{allLabel}</option>
        {/* A value the options do not have yet (still loading, or arrived by link) stays selectable. */}
        {value && !options.some((option) => option.value === value) && <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
