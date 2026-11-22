import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrackMap } from './TrackMap';
import type { TrackPath } from '@/lib/sim/analysis';
import { circle, makeLayout } from '@/test/track-fixture';
import { CHART_PALETTE } from '@/lib/chart-palette';

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

  it('is 16 rem tall unless the page makes it taller (a track page gives the map more room)', () => {
    const { rerender } = render(<TrackMap lap={lap} />);
    expect(screen.getByTestId('track-map').getAttribute('class')).toMatch(/(^|\s)h-56(\s|$)/);
    expect(screen.getByTestId('track-map').getAttribute('class')).toMatch(/\bmd:h-64\b/);
    rerender(<TrackMap lap={lap} className="h-96" />);
    expect(screen.getByTestId('track-map').getAttribute('class')).toMatch(/(^|\s)h-96(\s|$)/);
    expect(screen.getByTestId('track-map').getAttribute('class')).not.toMatch(/(^|\s)h-56(\s|$)/);
  });

  it('keeps z down: nothing is mirrored', () => {
    const { container } = render(<TrackMap lap={lap} />);
    const line = container.querySelector('polyline')!.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
    // The second point of the lap is further along x, the third further along z: both grow on the screen.
    expect(line[1][0]).toBeGreaterThan(line[0][0]);
    expect(line[2][1]).toBeGreaterThan(line[1][1]);
  });

  it('places the inspection marker in the recorded world without mirroring', () => {
    const { rerender } = render(<TrackMap lap={lap} cursor={{ x: 0, z: 0 }} />);
    const marker = () => screen.getByTestId('map-cursor');
    const firstX = Number(marker().getAttribute('cx'));
    const firstY = Number(marker().getAttribute('cy'));
    rerender(<TrackMap lap={lap} cursor={{ x: 20, z: 20 }} />);
    expect(Number(marker().getAttribute('cx'))).toBeGreaterThan(firstX);
    expect(Number(marker().getAttribute('cy'))).toBeGreaterThan(firstY);
    rerender(<TrackMap lap={lap} cursor={{ x: Number.NaN, z: 20 }} />);
    expect(screen.queryByTestId('map-cursor')).not.toBeInTheDocument();
  });

  it('keeps the inspected position visible when moving along a zoomed lap', () => {
    const { rerender } = render(<TrackMap lap={lap} cursor={{ x: 0, z: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    rerender(<TrackMap lap={lap} cursor={{ x: 20, z: 20 }} />);
    const [x, z, width, height] = screen.getByTestId('track-map').getAttribute('viewBox')!.split(' ').map(Number);
    const marker = screen.getByTestId('map-cursor');
    expect(Number(marker.getAttribute('cx'))).toBeGreaterThanOrEqual(x);
    expect(Number(marker.getAttribute('cx'))).toBeLessThanOrEqual(x + width);
    expect(Number(marker.getAttribute('cy'))).toBeGreaterThanOrEqual(z);
    expect(Number(marker.getAttribute('cy'))).toBeLessThanOrEqual(z + height);
    expect(screen.getByTestId('track-map')).toHaveAttribute('data-zoom', '2');
  });

  it('draws the road, the ideal line and the pit lane under the lap', () => {
    const layout = makeLayout({ points: circle(50, 40), width: 6, ideal: true, pit: [[0, 60], [30, 60], [60, 60]] });
    const { container } = render(<TrackMap lap={lap} layout={layout} />);
    expect(screen.getByTestId('track-layout')).toBeInTheDocument();
    expect(screen.getByTestId('track-ideal-line')).toBeInTheDocument();
    expect(screen.getByTestId('track-pitlane')).toBeInTheDocument();
    // The layout comes first in the drawing, so the lap is on top of it.
    const layoutGroup = screen.getByTestId('track-layout');
    const lapLine = [...container.querySelectorAll('polyline')].find((p) => p.getAttribute('stroke') === CHART_PALETTE.yellow);
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

  it('draws sampled edges exactly when widths are unknown, including non-normal offsets', () => {
    const layout = makeLayout({ points: [[0, 0], [10, 0]], closed: false });
    layout.boundaries = {
      left_x: new Float32Array([-4, 7]), left_z: new Float32Array([-2, -5]),
      right_x: new Float32Array([3, 14]), right_z: new Float32Array([1, 2]),
    };
    const { container } = render(<TrackMap lap={lap} layout={layout} />);
    // Bounds include the lap and the exact edges: min=(-4,-5), max=(20,20), margin=2.25.
    const road = container.querySelector('[data-testid="track-layout"] path')!;
    expect(road.getAttribute('d')).toBe('M2.3,5.3 L13.3,2.3 L20.3,9.3 L9.3,8.3 Z');
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

describe('the mouse on the map (owner, 2026-11-21: zoom with the wheel, drag, point at the lap)', () => {
  const box = { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  const map = () => {
    const element = screen.getByTestId('track-map');
    element.getBoundingClientRect = () => box;
    return element;
  };
  const viewBox = () => screen.getByTestId('track-map').getAttribute('viewBox')!.split(' ').map(Number);
  const roll = (deltaY: number, at = { clientX: 200, clientY: 200 }) => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...at });
    map().dispatchEvent(event);
    return event;
  };

  /** A pointer event as a browser sends it (jsdom has no PointerEvent: a mouse event of that name, with the pointer's fields added). */
  const pointer = (type: string, init: { clientX: number; clientY: number; pointerId?: number; pointerType?: string; buttons?: number }) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY, buttons: init.buttons ?? 0 });
    Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
    Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
    act(() => { map().dispatchEvent(event); });
  };

  it('zooms in when the wheel is rolled forward, and stops the page from scrolling while it does', async () => {
    render(<TrackMap lap={lap} />);
    const event = await act(() => roll(-400));
    expect(Number(screen.getByTestId('track-map').getAttribute('data-zoom'))).toBeGreaterThan(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('zooms towards the pointer: what is under it stays under it', async () => {
    render(<TrackMap lap={lap} />);
    const [x0, y0, w0, h0] = viewBox();
    // The pointer is a quarter of the way in from the left and from the top.
    const pointer = { clientX: 100, clientY: 100 };
    const under = { x: x0 + w0 * 0.25, y: y0 + h0 * 0.25 };
    await act(() => roll(-600, pointer));
    const [x1, y1, w1, h1] = viewBox();
    expect(w1).toBeLessThan(w0);
    expect(x1 + w1 * 0.25).toBeCloseTo(under.x, 0);
    expect(y1 + h1 * 0.25).toBeCloseTo(under.y, 0);
  });

  it('leaves the wheel to the page when the whole track is shown and it is rolled back (the page scrolls past the map)', async () => {
    render(<TrackMap lap={lap} />);
    const event = await act(() => roll(300));
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId('track-map').getAttribute('data-zoom')).toBe('1');
  });

  it('rolls back out to the whole track and no further', async () => {
    render(<TrackMap lap={lap} />);
    await act(() => roll(-600));
    await act(() => roll(5000));
    expect(screen.getByTestId('track-map').getAttribute('data-zoom')).toBe('1');
  });

  it('tells the page which place the mouse points at, in the game\'s own coordinates, and how near a point must be', async () => {
    const picked: Array<{ x: number; z: number; reach: number }> = [];
    render(<TrackMap lap={lap} onPick={(point, reach) => picked.push({ ...point, reach })} />);
    const w0 = viewBox()[2];
    // The middle of the picture is the middle of the lap's square (0..20 on both axes).
    pointer('pointermove', { clientX: 200, clientY: 200 });
    await vi.waitFor(() => expect(picked).toHaveLength(1));
    expect(picked[0].x).toBeCloseTo(10, 0);
    expect(picked[0].z).toBeCloseTo(10, 0);
    // The reach is a fixed number of screen pixels: 28 of them, in meters at this zoom.
    expect(picked[0].reach).toBeCloseTo((w0 / 400) * 28, 3);
  });

  it('does not pick while the map is being dragged, and picks where a press is let go without moving (a click or a tap)', async () => {
    const picked: unknown[] = [];
    render(<TrackMap lap={lap} onPick={(point) => picked.push(point)} />);
    await act(() => roll(-600));
    pointer('pointerdown', { clientX: 200, clientY: 200, buttons: 1 });
    pointer('pointermove', { clientX: 150, clientY: 180, buttons: 1 });
    pointer('pointerup', { clientX: 150, clientY: 180 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(picked).toHaveLength(0);
    pointer('pointerdown', { clientX: 120, clientY: 120, pointerId: 2, pointerType: 'touch' });
    pointer('pointerup', { clientX: 121, clientY: 120, pointerId: 2, pointerType: 'touch' });
    await vi.waitFor(() => expect(picked).toHaveLength(1));
  });
});
