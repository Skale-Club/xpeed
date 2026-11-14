import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { chooseOption, selectOptions } from '@/test/select';
import { PlainSelect } from './social-bits';

afterEach(cleanup);

const options = [{ value: 'recent', label: 'Recently driven' }, { value: 'az', label: 'Name (A to Z)' }];

describe('PlainSelect', () => {
  it('is compact: small, the name inside the control on the left and the value on the right, no caption above', () => {
    render(<PlainSelect label="Sort by" value="recent" onChange={() => {}} options={options} testId="sort" />);
    const trigger = screen.getByRole('combobox', { name: 'Sort by' });
    expect(trigger).toBe(screen.getByTestId('sort'));
    expect(trigger).toHaveClass('h-8', 'text-xs', 'focus-visible:ring-1', 'focus-visible:ring-offset-0');
    expect(trigger).toHaveTextContent(/^Sort byRecently driven$/);
    expect(document.querySelector('label')).toBeNull();
    for (const tall of ['h-9', 'h-10', 'h-11']) expect(trigger).not.toHaveClass(tall);
  });

  it('sits two to a row on a phone and has a width of its own on a wide screen, which a screen may change', () => {
    const { rerender } = render(<PlainSelect label="Sort by" value="recent" onChange={() => {}} options={options} />);
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveClass('min-w-0', 'flex-1', 'sm:flex-none', 'sm:w-40');
    rerender(<PlainSelect label="Sort by" value="recent" onChange={() => {}} options={options} className="sm:w-56" />);
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveClass('sm:w-56');
  });

  it('lists the options and reports the pick', () => {
    const onChange = vi.fn();
    render(<PlainSelect label="Sort by" value="recent" onChange={onChange} options={options} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort by' });
    expect(selectOptions(trigger)).toEqual(['Recently driven', 'Name (A to Z)']);
    chooseOption(trigger, 'Name (A to Z)');
    expect(onChange).toHaveBeenCalledWith('az');
  });

  it('keeps the label above a regular-height control when it is a field of a form (stacked)', () => {
    render(<PlainSelect stacked label="The link works" value="recent" onChange={() => {}} options={options} testId="expiry" />);
    const trigger = screen.getByRole('combobox', { name: 'The link works' });
    expect(trigger).toBe(screen.getByTestId('expiry'));
    expect(trigger).toHaveClass('h-10');
    expect(trigger).not.toHaveClass('h-8');
    const label = document.querySelector('label');
    expect(label).toHaveTextContent('The link works');
    expect(label).toHaveAttribute('for', trigger.id);
    // The name is not repeated inside the control.
    expect(trigger).toHaveTextContent(/^Recently driven$/);
  });
});
