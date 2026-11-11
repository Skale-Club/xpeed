import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrackMap } from './TrackMap';
import type { TrackPath } from '@/lib/sim/analysis';
import { circle, makeLayout } from '@/test/track-fixture';

afterEach(cleanup);

const lap: TrackPath = {
  points: [[0, 0], [20, 0], [20, 20], [0, 20]],
  minX: 0, maxX: 20, minZ: 0, maxZ: 20,
};

describe('the track map', () => {
  it('draws only the lap when there is no layout', () => {
    render(<TrackMap lap={lap} />);
    expect(screen.getByTestId('track-map')).toBeInTheDocument();
    expect(screen.queryByTestId('track-layout')).not.toBeInTheDocument();
  });

  it('keeps z down: nothing is mirrored', () => {
    const { container } = render(<TrackMap lap={lap} />);
    const line = container.querySelector('polyline')!.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
    // The second point of the lap is further along x, the third further along z: both grow on the screen.
    expect(line[1][0]).toBeGreaterThan(line[0][0]);
    expect(line[2][1]).toBeGreaterThan(line[1][1]);
  });

  it('draws the road, the ideal line and the pit lane under the lap', () => {
    const layout = makeLayout({ points: circle(50, 40), width: 6, ideal: true, pit: [[0, 60], [30, 60], [60, 60]] });
    const { container } = render(<TrackMap lap={lap} layout={layout} />);
    expect(screen.getByTestId('track-layout')).toBeInTheDocument();
    expect(screen.getByTestId('track-ideal-line')).toBeInTheDocument();
    expect(screen.getByTestId('track-pitlane')).toBeInTheDocument();
    // The layout comes first in the drawing, so the lap is on top of it.
    const layoutGroup = screen.getByTestId('track-layout');
    const lapLine = [...container.querySelectorAll('polyline')].find((p) => p.getAttribute('stroke')?.includes('94%, 49%'));
    expect(lapLine).toBeTruthy();
    expect(layoutGroup.compareDocumentPosition(lapLine!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes the road on itself when every width is known, so the inside of the ring stays empty', () => {
    const layout = makeLayout({ points: circle(50, 40), width: 6, closed: true });
    const { container } = render(<TrackMap lap={lap} layout={layout} />);
    const ring = container.querySelector('[data-testid="track-layout"] path')!;
    expect(ring.getAttribute('fill-rule')).toBe('evenodd');
    expect((ring.getAttribute('d')!.match(/M/g) ?? []).length).toBe(2);
  });

  it('draws the centre line as the track when no edge is known', () => {
    const layout = makeLayout({ points: circle(50, 40) });
    const { container } = render(<TrackMap lap={lap} layout={layout} />);
    expect(container.querySelectorAll('[data-testid="track-layout"] path')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="track-layout"] polyline')).toHaveLength(1);
  });

  it('shows the whole layout, not only the lap, in the picture', () => {
    const layout = makeLayout({ points: circle(500, 40), width: 6, closed: true });
    render(<TrackMap lap={lap} layout={layout} />);
    const [, , w, h] = screen.getByTestId('track-map').getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBeGreaterThan(1000);
    expect(h).toBeGreaterThan(1000);
  });

  it('zooms in on the middle and back out to the whole track', () => {
    const layout = makeLayout({ points: circle(500, 40), width: 6, closed: true });
    render(<TrackMap lap={lap} layout={layout} />);
    const box = () => screen.getByTestId('track-map').getAttribute('viewBox')!.split(' ').map(Number);
    const [, , whole] = box();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(box()[2]).toBeCloseTo(whole / 4, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(box()[2]).toBeCloseTo(whole / 2, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole track' }));
    expect(box()[2]).toBeCloseTo(whole, 0);
    expect(screen.getByRole('button', { name: 'Show the whole track' })).toBeDisabled();
  });

  it('zooms and moves with the keyboard', () => {
    render(<TrackMap lap={lap} />);
    const map = screen.getByTestId('track-map');
    fireEvent.keyDown(map, { key: '+' });
    expect(map.getAttribute('data-zoom')).toBe('2');
    const before = map.getAttribute('viewBox');
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    expect(map.getAttribute('viewBox')).not.toBe(before);
    fireEvent.keyDown(map, { key: '0' });
    expect(map.getAttribute('data-zoom')).toBe('1');
  });

  it('goes to a point asked for, zoomed in', () => {
    const { rerender } = render(<TrackMap lap={lap} />);
    rerender(<TrackMap lap={lap} focus={{ x: 20, z: 20, key: 1 }} />);
    expect(screen.getByTestId('track-map').getAttribute('data-zoom')).toBe('8');
  });

  it('stops zooming at a limit', () => {
    render(<TrackMap lap={lap} />);
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  });

  it('thins a huge layout instead of drawing every point', () => {
    const layout = makeLayout({ points: circle(500, 20000), width: 6, closed: true });
    const { container } = render(<TrackMap lap={lap} layout={layout} />);
    const ring = container.querySelector('[data-testid="track-layout"] path')!;
    expect((ring.getAttribute('d')!.match(/L/g) ?? []).length).toBeLessThan(4000);
  });
});
