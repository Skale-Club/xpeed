import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SearchCombobox } from './SearchCombobox';

afterEach(cleanup);

const options = [{ value: 'monza', label: 'Monza' }, { value: 'spa', label: 'Spa-Francorchamps' }];
const field = (extra: Partial<React.ComponentProps<typeof SearchCombobox>> = {}) => (
  <SearchCombobox label="Track" value="monza" onChange={() => {}} options={options} placeholder="Search a track" emptyText="Nothing" moreText="More" testId="track" {...extra} />
);

describe('SearchCombobox', () => {
  it('looks like the other drop-downs of a bar: small, with its name inside the control on the left and the value on the right', () => {
    render(field());
    const input = screen.getByRole('combobox', { name: 'Track' });
    const control = input.parentElement!;
    expect(control).toHaveClass('h-8', 'text-xs', 'rounded-lg', 'focus-within:ring-1');
    expect(control.firstElementChild).toHaveTextContent('Track');
    expect(input).toHaveValue('Monza');
    expect(input).toHaveClass('text-xs', 'text-right');
    // The name is not a caption above the field: the control is the first thing in the wrapper.
    expect(control.parentElement!.firstElementChild).toBe(control);
    for (const tall of ['h-9', 'h-10', 'h-11', 'text-sm']) expect(control).not.toHaveClass(tall);
  });

  it('types from the left while it is open, and still has its name, role and keyboard', () => {
    render(field());
    const input = screen.getByTestId('track');
    expect(input).toHaveAttribute('role', 'combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveClass('text-left');
    expect(screen.getByRole('listbox', { name: 'Track' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('sits two to a row on a phone and has a width of its own on a wide screen, which a screen may change', () => {
    const { container, rerender } = render(field());
    expect(container.firstElementChild).toHaveClass('min-w-0', 'flex-1', 'sm:flex-none', 'sm:w-56');
    rerender(field({ className: 'sm:w-72' }));
    expect(container.firstElementChild).toHaveClass('sm:w-72');
  });
});
