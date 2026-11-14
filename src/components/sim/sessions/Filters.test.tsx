import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { NO_FILTERS, type SessionFilters } from '@/lib/sim/sessions-view';
import { chooseOption, selectOptions } from '@/test/select';
import { SessionFilterBar } from './Filters';

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

describe('the compact filter toolbar of the Sessions page', () => {
  it('is one row: game, track, car, type and period as small drop-downs, then the switch, with no captions', () => {
    renderBar();
    const toolbar = screen.getByTestId('filter-toolbar');
    expect(toolbar).toHaveClass('flex-wrap');
    // The five drop-downs and the switch are all children of the one row.
    const children = [...toolbar.children];
    expect(within(toolbar).getAllByRole('combobox').map((box) => box.getAttribute('data-testid'))).toEqual(['filter-game', 'filter-track', 'filter-car', 'filter-kind', 'filter-period']);
    expect(children.map((child) => child.getAttribute('data-testid') ?? child.tagName)).toEqual(['filter-game', 'filter-track', 'filter-car', 'filter-kind', 'filter-period', 'LABEL']);
    // The switch is the last one, pushed to the right.
    expect(children.at(-1)).toHaveClass('sm:ml-auto');
    expect(within(toolbar).getByRole('switch', { name: 'Valid laps only' })).toBeInTheDocument();
    // No caption blocks above the controls: the names are on the controls.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('is not a card of its own, and every control is a compact drop-down', () => {
    renderBar();
    const section = screen.getByTestId('session-filters');
    expect(section).not.toHaveClass('border');
    expect(section).not.toHaveClass('p-2');
    for (const id of ['filter-game', 'filter-track', 'filter-car', 'filter-kind', 'filter-period']) expect(screen.getByTestId(id)).toHaveClass('h-8', 'text-xs');
  });

  it('puts the name of each drop-down inside it, on the left, with the value on the right', () => {
    renderBar({ ...NO_FILTERS, track: 't1' });
    const game = screen.getByRole('combobox', { name: 'Game' });
    expect(game).toHaveTextContent(/^GameAll$/);
    expect(screen.getByRole('combobox', { name: 'Track' })).toHaveTextContent(/^TrackMonza$/);
    expect(screen.getByRole('combobox', { name: 'Car' })).toHaveTextContent(/^CarAll$/);
  });

  it('offers the type and the period as drop-downs named on the control, and reports what is picked', () => {
    const { onChange } = renderBar();
    const kind = screen.getByRole('combobox', { name: 'Type' });
    const period = screen.getByRole('combobox', { name: 'Period' });
    expect(kind).toHaveTextContent(/^TypeAll$/);
    expect(period).toHaveTextContent(/^PeriodAny time$/);
    expect(selectOptions(kind)).toEqual(['All', 'Practice', 'Qualifying', 'Race']);
    expect(selectOptions(period)).toEqual(['Any time', '7 days', '30 days', '90 days', '12 months']);
    chooseOption(kind, 'Race');
    expect(onChange).toHaveBeenLastCalledWith('kind', 'race');
    chooseOption(period, '30 days');
    expect(onChange).toHaveBeenLastCalledWith('period', '30d');
  });

  it('reports a game picked in the drop-down, and the switch', () => {
    const { onChange } = renderBar();
    chooseOption(screen.getByTestId('filter-game'), 'Assetto Corsa');
    expect(onChange).toHaveBeenLastCalledWith('game', 'ac');
    fireEvent.click(screen.getByRole('switch', { name: 'Valid laps only' }));
    expect(onChange).toHaveBeenLastCalledWith('validOnly', true);
  });

  it('shows the line of chips only while a filter is on, and clears them', () => {
    const none = renderBar();
    expect(screen.queryByTestId('active-filters')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clear-filters')).not.toBeInTheDocument();
    cleanup();

    const { onChange, onClear } = renderBar({ ...NO_FILTERS, track: 't1', validOnly: true });
    const chips = screen.getByTestId('active-filters');
    // A second, thin line under the toolbar, not a part of it.
    expect(screen.getByTestId('filter-toolbar')).not.toContainElement(chips);
    expect(chips).toHaveClass('pt-2');
    expect(within(chips).getByTestId('chip-track')).toHaveTextContent('Monza');
    expect(within(chips).getByTestId('chip-valid')).toBeInTheDocument();
    fireEvent.click(within(chips).getByTestId('chip-track'));
    expect(onChange).toHaveBeenLastCalledWith('track', '');
    fireEvent.click(screen.getByTestId('clear-filters'));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(none.onChange).not.toHaveBeenCalled();
  });
});
