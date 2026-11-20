import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackFile } from '@/lib/sim/track-file';
import { TrackLayoutThumb } from './TrackLayoutThumb';

const queries = vi.hoisted(() => ({
  detail: { data: undefined as unknown, isLoading: false },
  layout: { data: undefined as unknown, isLoading: false },
  wanted: [] as unknown[],
}));

vi.mock('@/lib/sim/garage-queries', () => ({
  useOnScreen: () => [() => undefined, true],
  useTrackDetail: () => queries.detail,
  useTrackLayout: (wanted: unknown) => { queries.wanted.push(wanted); return queries.layout; },
}));

const circle: TrackFile = {
  header: { closed: true },
  centerline: { x: Array.from({ length: 40 }, (_, i) => Math.cos((i / 40) * Math.PI * 2) * 100), z: Array.from({ length: 40 }, (_, i) => Math.sin((i / 40) * Math.PI * 2) * 60) },
} as unknown as TrackFile;

describe('TrackLayoutThumb', () => {
  beforeEach(() => {
    queries.detail = { data: undefined, isLoading: false };
    queries.layout = { data: undefined, isLoading: false };
    queries.wanted = [];
  });

  it('draws the layout the account holds for the track, hidden from screen readers next to the name', () => {
    queries.detail = { data: { track: { id: 't1', game: 'ac', name: 'Laguna Seca', hasLayout: true, layoutId: 'L1' } }, isLoading: false };
    queries.layout = { data: circle, isLoading: false };
    render(<TrackLayoutThumb trackId="t1" name="Laguna Seca" />);
    const map = screen.getByTestId('track-thumb');
    expect(map).toHaveAttribute('aria-hidden', 'true');
    expect(map.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(queries.wanted.at(-1)).toEqual({ game: 'ac', name: 'Laguna Seca', layoutId: 'L1' });
  });

  it('keeps a placeholder of the same size when the track has no layout, and looks for none', () => {
    queries.detail = { data: { track: { id: 't2', game: 'ac', name: 'Raul Boesel', hasLayout: false, layoutId: null } }, isLoading: false };
    render(<TrackLayoutThumb trackId="t2" name="Raul Boesel" className="h-11 w-11" />);
    expect(screen.getByTestId('track-thumb-none')).toBeInTheDocument();
    expect(screen.getByTestId('track-layout-thumb')).toHaveClass('h-11', 'w-11');
    expect(queries.wanted.at(-1)).toBeNull();
  });

  it('shows a skeleton while the track is read, and the placeholder when it cannot be', () => {
    queries.detail = { data: undefined, isLoading: true };
    const { rerender } = render(<TrackLayoutThumb trackId="t3" name="Monza" />);
    expect(screen.getByTestId('track-thumb-loading')).toBeInTheDocument();
    queries.detail = { data: undefined, isLoading: false };
    rerender(<TrackLayoutThumb trackId="t3" name="Monza" />);
    expect(screen.getByTestId('track-thumb-none')).toBeInTheDocument();
  });
});
