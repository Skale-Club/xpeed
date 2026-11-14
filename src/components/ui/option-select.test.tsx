import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OptionSelect, EMPTY_OPTION_VALUE, type SelectOption } from '@/components/ui/option-select';
import { chooseOption, openSelect, selectOptions } from '@/test/select';

const options: SelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true },
];

/** The picked value lives in the test, as it does in a screen. */
function Harness({ initial = '', onChange, ...rest }: { initial?: string; onChange?: (value: string) => void } & Partial<React.ComponentProps<typeof OptionSelect>>) {
  const [value, setValue] = useState(initial);
  return <OptionSelect aria-label="Letter" options={options} {...rest} value={value} onChange={(next) => { setValue(next); onChange?.(next); }} />;
}

describe('OptionSelect', () => {
  it('opens as a list of options, with the keyboard', () => {
    render(<Harness emptyLabel="All" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const list = openSelect(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['All', 'Alpha', 'Bravo', 'Charlie']);
  });

  it('picks an option with a click, shows it and reports its value', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} placeholder="Pick a letter" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveTextContent('Pick a letter');
    chooseOption(trigger, 'Bravo');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(trigger).toHaveTextContent('Bravo');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('picks an option with the keyboard: Enter to open, the arrows to move, Enter to choose', async () => {
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    openSelect(trigger);
    // The picked entry has the focus when the list opens; one arrow down is the next one.
    await waitFor(() => expect(screen.getByRole('option', { name: 'Alpha' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bravo' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
    expect(trigger).toHaveTextContent('Bravo');
  });

  it('closes on Escape without changing anything', () => {
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    fireEvent.keyDown(openSelect(trigger), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent('Alpha');
  });

  it("maps '' to the empty entry (\"All\") and back, though Radix cannot hold an empty value", () => {
    const onChange = vi.fn();
    render(<Harness initial="" emptyLabel="All" onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveTextContent('All');
    expect(selectOptions(trigger)[0]).toBe('All');
    chooseOption(trigger, 'Alpha');
    expect(onChange).toHaveBeenLastCalledWith('a');
    chooseOption(trigger, 'All');
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(trigger).toHaveTextContent('All');
    expect(EMPTY_OPTION_VALUE).not.toBe('');
  });

  it("takes an option of its own with the value '' as the empty entry, once", () => {
    render(<Harness initial="" options={[{ value: '', label: 'Any car' }, { value: 'x', label: 'X' }]} emptyLabel="All" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveTextContent('Any car');
    expect(selectOptions(trigger)).toEqual(['Any car', 'X']);
  });

  it('keeps a value the options do not have (still loading, or from a link) selected and listed', () => {
    render(<Harness initial="zzz" emptyLabel="All" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveTextContent('zzz');
    expect(selectOptions(trigger)).toContain('zzz');
  });

  it('does not open when disabled', () => {
    render(<Harness disabled initial="a" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toBeDisabled();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not let a disabled option be chosen', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    const list = openSelect(trigger);
    const charlie = within(list).getByRole('option', { name: 'Charlie' });
    expect(charlie).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(charlie);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps its accessible name: the aria-label, a label for it, or the inline label', () => {
    const { unmount } = render(<OptionSelect aria-label="By aria-label" value="" onChange={() => {}} options={options} />);
    expect(screen.getByRole('combobox', { name: 'By aria-label' })).toBeInTheDocument();
    unmount();

    const labelled = render(<><label htmlFor="pick">By label</label><OptionSelect id="pick" value="" onChange={() => {}} options={options} /></>);
    expect(screen.getByLabelText('By label')).toBe(screen.getByRole('combobox', { name: 'By label' }));
    labelled.unmount();

    render(<OptionSelect label="Game" value="a" onChange={() => {}} options={options} data-testid="inline" />);
    const trigger = screen.getByRole('combobox', { name: 'Game' });
    expect(trigger).toBe(screen.getByTestId('inline'));
    // The label is inside the control, on the left, and the value follows it.
    expect(trigger).toHaveTextContent(/^GameAlpha$/);
    expect(trigger.firstElementChild).toHaveTextContent('Game');
  });

  it('puts the data-testid on the trigger', () => {
    render(<OptionSelect aria-label="Letter" value="a" onChange={() => {}} options={options} data-testid="letters" />);
    expect(screen.getByTestId('letters')).toBe(screen.getByRole('combobox'));
  });

  it('ends a long value with an ellipsis instead of running into the arrow', () => {
    const long = 'A track layout with a very long name that cannot fit in a small control · Grand Prix · 2026 configuration';
    render(<OptionSelect aria-label="Layout" size="sm" className="w-40" value="l" onChange={() => {}} options={[{ value: 'l', label: long }]} />);
    const trigger = screen.getByRole('combobox', { name: 'Layout' });
    const value = within(trigger).getByText(long);
    expect(value.tagName).toBe('SPAN');
    // The trigger styles its spans (the value is one): they may shrink and end in an ellipsis.
    expect(trigger.className).toContain('[&>span]:truncate');
    expect(trigger.className).toContain('[&>span]:min-w-0');
    // The arrow is its own fixed-size item of the row, so it never sits on the text.
    const arrow = trigger.querySelector('svg');
    expect(arrow).toHaveClass('shrink-0');
    expect(trigger).toHaveClass('items-center');
    expect(trigger).toHaveClass('gap-1.5');
  });

  it('has a compact size for toolbars and a regular one for forms', () => {
    const { rerender } = render(<OptionSelect aria-label="Size" size="sm" value="a" onChange={() => {}} options={options} />);
    expect(screen.getByRole('combobox')).toHaveClass('h-8', 'text-xs');
    rerender(<OptionSelect aria-label="Size" value="a" onChange={() => {}} options={options} />);
    expect(screen.getByRole('combobox')).toHaveClass('h-10');
  });

  it('lists grouped options under their heading, after the ones without a group', () => {
    render(<Harness options={[{ value: 'x', label: 'Plain' }, { value: 'g1', label: 'In group', group: 'Group A' }]} />);
    const list = openSelect(screen.getByRole('combobox', { name: 'Letter' }));
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['Plain', 'In group']);
    expect(within(list).getByText('Group A')).toBeInTheDocument();
  });
});
