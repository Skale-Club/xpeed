import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { chooseOption, selectOptions } from '@/test/select';
import { FilterSelect } from './FilterSelect';

afterEach(cleanup);

const options = [{ value: 'lmu', label: 'Le Mans Ultimate' }, { value: 'ac', label: 'Assetto Corsa' }];

describe('FilterSelect', () => {
  it('is always the compact one: the name is inside the control, on the left, and the value is on the right', () => {
    const { container } = render(<FilterSelect label="Game" allLabel="All" value="" onChange={() => {}} options={options} testId="game" />);
    const trigger = screen.getByRole('combobox', { name: 'Game' });
    expect(trigger).toBe(screen.getByTestId('game'));
    expect(trigger).toHaveClass('h-8', 'text-xs');
    expect(trigger).toHaveTextContent(/^GameAll$/);
    expect(trigger.firstElementChild).toHaveTextContent('Game');
    // There is no caption above it any more: no <label> element, and nothing wraps the control.
    expect(document.querySelector('label')).toBeNull();
    expect(container.firstElementChild).toBe(trigger);
  });

  it('is not a taller control with a stacked label, whatever the screen does', () => {
    render(<FilterSelect label="Track" allLabel="Choose a track" value="" onChange={() => {}} options={options} />);
    const trigger = screen.getByRole('combobox', { name: 'Track' });
    for (const tall of ['h-9', 'h-10', 'h-11', 'text-sm']) expect(trigger).not.toHaveClass(tall);
  });

  it('has a thin focus ring with no offset, like every compact control', () => {
    render(<FilterSelect label="Game" allLabel="All" value="" onChange={() => {}} options={options} />);
    const trigger = screen.getByRole('combobox', { name: 'Game' });
    expect(trigger).toHaveClass('focus-visible:ring-1', 'focus-visible:ring-offset-0');
  });

  it('sits two to a row on a phone and keeps a fixed width on a wide screen, which a screen may change', () => {
    const { rerender } = render(<FilterSelect label="Game" allLabel="All" value="" onChange={() => {}} options={options} />);
    const trigger = screen.getByRole('combobox', { name: 'Game' });
    expect(trigger).toHaveClass('min-w-0', 'flex-1', 'sm:flex-none', 'sm:w-32');
    expect(trigger.className).toContain('basis-[calc(50%-0.25rem)]');
    rerender(<FilterSelect label="Game" allLabel="All" value="" onChange={() => {}} options={options} className="sm:w-56" />);
    expect(screen.getByRole('combobox', { name: 'Game' })).toHaveClass('sm:w-56');
    expect(screen.getByRole('combobox', { name: 'Game' })).not.toHaveClass('sm:w-32');
  });

  it('starts the list with the "all" entry, reports the pick and shows it on the right', () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterSelect label="Game" allLabel="All" value="" onChange={onChange} options={options} />);
    const trigger = screen.getByRole('combobox', { name: 'Game' });
    expect(selectOptions(trigger)).toEqual(['All', 'Le Mans Ultimate', 'Assetto Corsa']);
    chooseOption(trigger, 'Assetto Corsa');
    expect(onChange).toHaveBeenCalledWith('ac');
    rerender(<FilterSelect label="Game" allLabel="All" value="ac" onChange={onChange} options={options} />);
    expect(screen.getByRole('combobox', { name: 'Game' })).toHaveTextContent(/^GameAssetto Corsa$/);
  });
});
