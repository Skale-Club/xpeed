import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { FILTER_CELL } from '@/components/ui/filter-bar';
import { cn } from '@/lib/utils';
import { COMBO_LIMIT, filterOptions } from './social-utils';

export interface ComboOption {
  value: string;
  label: string;
  /** An option with a group goes under that heading (the groups keep the order they first appear in). */
  group?: string;
}

/**
 * A drop-down you can search: type to narrow the list, arrows to move, Enter to choose, Escape to close. A text field with the combobox
 * pattern (`role="combobox"`, a listbox of options), so a screen reader says what it is and which option is active. It looks like the other
 * drop-downs of a filter bar: small (h-8, text-xs), its name inside the control on the left, the value (or what is being typed) after it.
 */
export function SearchCombobox({ label, value, onChange, options, placeholder, emptyText, moreText, testId, disabled, className }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboOption[];
  /** Shown in the field while it is empty and open (what to type). */
  placeholder: string;
  /** Said when nothing matches what was typed. */
  emptyText: string;
  /** Said under the list when it was cut at `COMBO_LIMIT`. */
  moreText: string;
  testId?: string;
  disabled?: boolean;
  /** The width on a wide screen (a phone gets two to a row, or the whole row). */
  className?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const labelId = `${id}-label`;
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const selected = options.find((option) => option.value === value) ?? null;
  const matches = useMemo(() => filterOptions(options, query), [options, query]);
  const shown = matches.slice(0, COMBO_LIMIT);
  const groups = useMemo(() => [...new Set(shown.flatMap((option) => (option.group ? [option.group] : [])))], [shown]);
  // The drawn order: options with no group first, then each group in turn; the active index counts in this order.
  const ordered = useMemo(
    () => [...shown.filter((option) => !option.group), ...groups.flatMap((group) => shown.filter((option) => option.group === group))],
    [shown, groups],
  );
  const activeOption = open ? ordered[Math.min(active, Math.max(0, ordered.length - 1))] : undefined;
  const optionId = (option: ComboOption) => `${id}-opt-${option.value}`;

  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    if (!open || !activeOption) return;
    document.getElementById(optionId(activeOption))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeOption?.value]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (option: ComboOption) => {
    if (option.value !== value) onChange(option.value);
    close();
  };
  const openList = () => {
    if (disabled) return;
    if (!open) {
      const at = ordered.findIndex((option) => option.value === value);
      setActive(at >= 0 ? at : 0);
    }
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) return openList();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (ordered.length > 0) setActive((now) => (now + step + ordered.length) % ordered.length);
        return;
      }
      case 'Home':
        if (open) { event.preventDefault(); setActive(0); }
        return;
      case 'End':
        if (open) { event.preventDefault(); setActive(Math.max(0, ordered.length - 1)); }
        return;
      case 'Enter':
        if (open) {
          event.preventDefault();
          if (activeOption) choose(activeOption);
        }
        return;
      case 'Escape':
        if (open) { event.preventDefault(); close(); }
        return;
      case 'Tab':
        close();
        return;
    }
  };

  const optionRow = (option: ComboOption) => {
    const isActive = option.value === activeOption?.value;
    const isSelected = option.value === value;
    return (
      <li
        key={option.value}
        id={optionId(option)}
        role="option"
        aria-selected={isSelected}
        data-active={isActive ? 'true' : undefined}
        data-testid={testId ? `${testId}-option` : undefined}
        data-value={option.value}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActive(ordered.findIndex((entry) => entry.value === option.value))}
        onClick={() => choose(option)}
        className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm', isActive && 'bg-muted', isSelected && 'font-medium')}
      >
        <span className="min-w-0 truncate">{option.label}</span>
        {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
      </li>
    );
  };

  return (
    <div
      ref={wrapper}
      className={cn(FILTER_CELL, 'relative sm:w-56', className)}
      onBlur={(event) => {
        if (!wrapper.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <div
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background/60 pl-2.5 pr-2 text-xs transition-colors focus-within:ring-1 focus-within:ring-ring',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span id={labelId} className="shrink-0 text-muted-foreground">{label}</span>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-labelledby={labelId}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          value={open ? query : selected?.label ?? value}
          placeholder={open ? selected?.label ?? placeholder : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={openList}
          onClick={openList}
          onKeyDown={onKeyDown}
          className={cn('h-full min-w-0 flex-1 bg-transparent py-0 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed', open ? 'text-left' : 'truncate text-right')}
          data-testid={testId}
          data-value={value}
        />
        <ChevronsUpDown className="pointer-events-none h-4 w-4 shrink-0 text-muted-foreground opacity-60" aria-hidden="true" />
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            className="absolute left-0 top-full z-30 mt-1 max-h-64 min-w-full w-max max-w-[min(26rem,calc(100vw-2rem))] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            data-testid={testId ? `${testId}-list` : undefined}
          >
            {ordered.length === 0 && <li role="presentation" className="px-2 py-2 text-sm text-muted-foreground" data-testid={testId ? `${testId}-empty` : undefined}>{emptyText}</li>}
            {shown.filter((option) => !option.group).map(optionRow)}
            {groups.map((group) => (
              <li key={group} role="presentation">
                <ul role="group" aria-label={group}>
                  <li role="presentation" className="px-2 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground" aria-hidden="true">{group}</li>
                  {shown.filter((option) => option.group === group).map(optionRow)}
                </ul>
              </li>
            ))}
            {matches.length > COMBO_LIMIT && <li role="presentation" className="px-2 py-1.5 text-xs text-muted-foreground">{moreText}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
