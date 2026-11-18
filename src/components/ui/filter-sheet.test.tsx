import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { FilterSheet } from './filter-sheet';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

describe('FilterSheet', () => {
  it('is a Filters button (h-10) with nothing open at first', () => {
    render(<FilterSheet count={0} onClear={() => {}} testId="fs"><p>the controls</p></FilterSheet>);
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveClass('h-10');
    expect(screen.queryByText('the controls')).toBeNull();
    expect(screen.queryByTestId('fs-count')).toBeNull();
  });

  it('shows how many filters are on', () => {
    render(<FilterSheet count={3} onClear={() => {}} testId="fs"><p>x</p></FilterSheet>);
    expect(screen.getByTestId('fs-count')).toHaveTextContent('3');
  });

  it('opens a bottom sheet with the controls and closes with Show results', () => {
    render(<FilterSheet count={1} onClear={() => {}} testId="fs"><p>the controls</p></FilterSheet>);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-[85vh]');
    expect(screen.getByText('the controls')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show results' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clears all filters, and has nothing to clear at zero', () => {
    const onClear = vi.fn();
    const { rerender } = render(<FilterSheet count={2} onClear={onClear}><p>x</p></FilterSheet>);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    rerender(<FilterSheet count={0} onClear={onClear}><p>x</p></FilterSheet>);
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  });
});
