import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { NO_FILTERS, type SessionFilters } from '@/lib/sim/sessions-view';
import { chooseOption } from '@/test/select';
import { SessionFilterBar } from './Filters';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));

const games = [{ value: 'lmu', label: 'Le Mans Ultimate' }, { value: 'ac', label: 'Assetto Corsa' }];
const tracks = [{ value: 't1', label: 'Monza' }];
const cars = [{ value: 'c1', label: 'Ferrari 499P' }];

function renderBar(filters: SessionFilters = NO_FILTERS) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(<SessionFilterBar filters={filters} onChange={onChange} onClear={onClear} gameOptions={games} trackOptions={tracks} carOptions={cars} />);
  return { onChange, onClear };
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the filters of the Sessions page on a phone', () => {
  it('is one Filters button, with the toolbar and the controls out of the page until it is opened', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveClass('h-10');
    expect(screen.queryByTestId('filter-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-game')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filters-count')).not.toBeInTheDocument();
  });

  it('shows how many filters are on in the button', () => {
    renderBar({ ...NO_FILTERS, track: 't1', validOnly: true });
    expect(screen.getByTestId('filters-count')).toHaveTextContent('2');
  });

  it('opens a sheet with the five drop-downs and the switch, all h-10', () => {
    renderBar();
    fireEvent.click(screen.getByTestId('filters-open'));
    const sheet = screen.getByTestId('filters-sheet');
    for (const id of ['filter-game', 'filter-track', 'filter-car', 'filter-kind', 'filter-period']) expect(within(sheet).getByTestId(id)).toHaveClass('h-10', 'w-full');
    expect(within(sheet).getByRole('switch', { name: 'Valid laps only' })).toBeInTheDocument();
    expect(within(sheet).getByTestId('filters-clear-all')).toHaveClass('h-10');
    expect(within(sheet).getByTestId('filters-show-results')).toHaveClass('h-10');
  });

  it('reports a change with the same handler as the desktop bar', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByTestId('filters-open'));
    chooseOption(screen.getByTestId('filter-game'), 'Assetto Corsa');
    expect(onChange).toHaveBeenLastCalledWith('game', 'ac');
    fireEvent.click(screen.getByRole('switch', { name: 'Valid laps only' }));
    expect(onChange).toHaveBeenLastCalledWith('validOnly', true);
  });

  it('clears everything with Clear all and closes the sheet with Show results', () => {
    const { onClear } = renderBar({ ...NO_FILTERS, track: 't1' });
    fireEvent.click(screen.getByTestId('filters-open'));
    fireEvent.click(screen.getByTestId('filters-clear-all'));
    expect(onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('filters-show-results'));
    expect(screen.queryByTestId('filters-sheet')).not.toBeInTheDocument();
  });

  it('keeps the chips under the button, h-8, and removes one by its tap', () => {
    const { onChange } = renderBar({ ...NO_FILTERS, track: 't1' });
    const chip = screen.getByTestId('chip-track');
    expect(chip).toHaveClass('h-8', 'text-xs');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith('track', '');
  });
});
