import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** An option with a group goes under that heading; groups keep the order they first appear in, after the options without one. */
  group?: string;
}

/**
 * Radix Select items cannot have the empty string as their value (it is how Radix says "nothing picked"). The app's "All" entries do use
 * '' (it is what goes in the address), so '' travels through Radix as this word and comes back as ''.
 */
export const EMPTY_OPTION_VALUE = '__option-select-empty__';

export interface OptionSelectProps {
  /** The picked value; '' is the "all" / empty entry. */
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<SelectOption>;
  /** Adds a first entry with the value '' and this label (the "All" of a filter). An option of your own with value '' does the same. */
  emptyLabel?: string;
  /** Shown while nothing is picked (and there is no '' entry). */
  placeholder?: string;
  /** A label drawn inside the control, on the left, with the value on the right (the compact toolbar look). It is also the accessible name unless aria-label is given. */
  label?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  size?: 'sm' | 'md';
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

/**
 * The app's drop-down: Radix Select (a dark popover, a check mark, the keyboard) behind a plain `value` / `onChange(value)` / `options` API, so a screen
 * can swap a native `<select>` for it. A value the options do not have (still loading, or arrived by link) stays selectable, like a native select.
 */
export function OptionSelect({
  value,
  onChange,
  options,
  emptyLabel,
  placeholder,
  label,
  id,
  size = 'md',
  className,
  contentClassName,
  disabled,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: OptionSelectProps) {
  const { plain, groups, hasEmpty } = useMemo(() => {
    const list: SelectOption[] = [...options];
    if (emptyLabel !== undefined && !list.some((option) => option.value === '')) list.unshift({ value: '', label: emptyLabel });
    if (value !== '' && !list.some((option) => option.value === value)) list.push({ value, label: value });
    const names = [...new Set(list.flatMap((option) => (option.group ? [option.group] : [])))];
    return {
      plain: list.filter((option) => !option.group),
      groups: names.map((name) => ({ name, items: list.filter((option) => option.group === name) })),
      hasEmpty: list.some((option) => option.value === ''),
    };
  }, [options, emptyLabel, value]);

  const toRadix = (raw: string) => (raw === '' && hasEmpty ? EMPTY_OPTION_VALUE : raw);
  const item = (option: SelectOption) => (
    <SelectItem key={option.value || EMPTY_OPTION_VALUE} value={toRadix(option.value)} disabled={option.disabled}>
      {option.label}
    </SelectItem>
  );

  return (
    <Select
      value={toRadix(value)}
      onValueChange={(next) => onChange(next === EMPTY_OPTION_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : label)}
        aria-labelledby={ariaLabelledBy}
        data-testid={testId}
        className={cn(
          size === 'sm' ? 'h-8 gap-1.5 rounded-lg py-0 pl-2.5 pr-2 text-xs' : 'h-10 py-0',
          'min-w-0',
          // Radix ignores a className on SelectValue, so the value (the last span) is styled from here: it takes the room that is left, on the right.
          label && '[&>span:last-of-type]:flex-1 [&>span:last-of-type]:text-right [&>span:last-of-type]:text-foreground',
          className,
        )}
      >
        {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {plain.map(item)}
        {groups.map((group) => (
          <SelectGroup key={group.name}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.items.map(item)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
