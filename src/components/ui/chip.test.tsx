import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chip } from './chip';

afterEach(cleanup);

describe('Chip', () => {
  it('is a plain label with no button when it has no handlers', () => {
    render(<Chip testId="c">Monza</Chip>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('c')).toHaveClass('rounded-full', 'h-8');
  });

  it('is a toggle button whose aria-pressed follows selected', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Chip onClick={onClick}>Valid</Chip>);
    const button = screen.getByRole('button', { name: 'Valid' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Chip onClick={onClick} selected testId="c">Valid</Chip>);
    expect(screen.getByRole('button', { name: 'Valid' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('c')).toHaveClass('border-primary', 'bg-primary/10');
  });

  it('adds a labelled remove button with a 32px hit area', () => {
    const onRemove = vi.fn();
    render(<Chip onRemove={onRemove} removeLabel="Remove the filter: Monza">Monza</Chip>);
    const remove = screen.getByRole('button', { name: 'Remove the filter: Monza' });
    expect(remove).toHaveClass('h-8', 'w-8');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('is shorter at size sm', () => {
    render(<Chip size="sm" testId="c">x</Chip>);
    expect(screen.getByTestId('c')).toHaveClass('h-7');
  });
});
