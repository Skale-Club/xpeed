import { useRef, type KeyboardEvent } from 'react';

/** One choice out of a few as a row of buttons (a radio group: the arrows move between them, Tab goes past), the look of the Overview's period selector. */
export function Segmented<T extends string>({ value, onChange, options, label, testId, optionTestId }: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  label: string;
  testId?: string;
  optionTestId?: (value: T) => string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full rounded-lg border border-border bg-muted/40 p-0.5 sm:inline-flex sm:w-auto" data-testid={testId}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value || 'all'}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            data-testid={optionTestId?.(option.value)}
            className={`min-h-8 flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none ${
              selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
