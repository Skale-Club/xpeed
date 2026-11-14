import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FILTER_CELL, FILTER_WIDE_CELL, FilterBar } from './filter-bar';

afterEach(cleanup);

describe('FilterBar', () => {
  it('is one wrapping row of small controls with no card, border or padding of its own', () => {
    render(<FilterBar data-testid="bar"><button>One</button><button>Two</button></FilterBar>);
    const bar = screen.getByTestId('bar');
    expect(bar).toHaveClass('flex', 'flex-wrap', 'items-center', 'gap-2');
    for (const chrome of ['border', 'bg-card', 'p-2', 'p-3', 'p-4', 'rounded-lg', 'shadow']) expect(bar).not.toHaveClass(chrome);
    expect([...bar.children].map((child) => child.textContent)).toEqual(['One', 'Two']);
  });

  it('keeps the role, the name and any class a screen gives it', () => {
    render(<FilterBar role="search" aria-label="Filter the tracks" className="mt-2">x</FilterBar>);
    expect(screen.getByRole('search', { name: 'Filter the tracks' })).toHaveClass('flex-wrap', 'mt-2');
  });

  it('gives a control half a row on a phone (a lone one the whole row) and a fixed width from sm up', () => {
    expect(FILTER_CELL).toContain('basis-[calc(50%-0.25rem)]');
    expect(FILTER_CELL).toContain('flex-1');
    expect(FILTER_CELL).toContain('min-w-0');
    expect(FILTER_CELL).toContain('sm:flex-none');
    // A search box takes a whole row on a phone.
    expect(FILTER_WIDE_CELL).toContain('basis-full');
    expect(FILTER_WIDE_CELL).toContain('sm:flex-none');
  });
});
