import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { colorref, parseFrame } from '@/lib/sim/live-frame';
import { LiveDashboard } from './LiveDashboard';
import { ALL_WIDGET_IDS, elem, sampleFrame, sampleModel } from './live-fixture';

afterEach(cleanup);

const widget = (id: string) => document.querySelector(`[data-widget="${id}"]`) as HTMLElement | null;
const open = (over: Parameters<typeof sampleFrame>[0] = {}) => render(<LiveDashboard frame={sampleFrame(over)} />);

describe('the phone dashboard', () => {
  it('draws the rows in order, two ids side by side, and skips an id it does not know', () => {
    open();
    const rows = [...document.querySelectorAll('[data-row]')].map((row) => row.getAttribute('data-row'));
    expect(rows).toEqual(['times', 'centre,fuel', 'tyres', 'delta_bar', 'session', 'relative', 'flag', 'radar', 'mystery']);
    expect(document.querySelector('[data-row="centre,fuel"]')).toHaveClass('grid-cols-2');
    expect(document.querySelector('[data-row="times"]')).toHaveClass('grid-cols-1');
    expect(document.querySelector('[data-row="mystery"]')?.children).toHaveLength(0);
    const order = [...document.querySelectorAll('[data-widget]')].map((w) => w.getAttribute('data-widget'));
    expect(order).toEqual(['times', 'centre', 'fuel', 'tyres', 'delta_bar', 'session', 'relative', 'flag', 'radar']);
  });

  it('knows all 18 widgets of the catalog', () => {
    open({ rows: ALL_WIDGET_IDS.map((id) => [id]) });
    for (const id of ALL_WIDGET_IDS) expect(widget(id), id).not.toBeNull();
  });

  it('draws a widget whose part of the model is missing as nothing, and the rest as usual', () => {
    const model = sampleModel();
    delete model.flag;
    model.session = undefined;
    model.sessionCard = null;
    open({ model, rows: [['flag'], ['session'], ['times']] });
    expect(widget('flag')).toBeNull();
    expect(widget('session')).toBeNull();
    expect(widget('times')).not.toBeNull();
  });

  it('shows the track and the car, and the banner of a paused game', () => {
    const model = sampleModel();
    model.banner = { kind: 'paused', title: 'Paused', note: 'The game is paused' };
    open({ model });
    expect(screen.getByTestId('live-context')).toHaveTextContent('Spa-Francorchamps');
    expect(screen.getByTestId('live-banner')).toHaveTextContent('The game is paused');
  });

  it('dims what the Companion says is dimmed', () => {
    const model = sampleModel();
    model.sessionCard = { ...model.sessionCard!, show: 'dimmed' };
    open({ model });
    expect(widget('session')).toHaveClass('opacity-50');
    expect(widget('times')).not.toHaveClass('opacity-50');
  });

  it('colours a figure by its role', () => {
    open();
    const delta = within(widget('times')!).getByText('-0.270');
    expect(delta).toHaveClass('text-success');
    expect(within(widget('times')!).getByText('1:47.100')).toHaveClass('text-brand-3');
  });
});

describe('the widgets', () => {
  it('flag: a colour block with the word, the chequered pattern, and NO FLAG', () => {
    const flag = (kind: 'yellow' | 'chequered' | null, word: string) => <LiveDashboard frame={sampleFrame({ model: { ...sampleModel(), flag: { show: 'shown', title: 'Flag', kind, word } }, rows: [['flag']] })} />;
    const { rerender } = render(flag('yellow', 'YELLOW'));
    const yellow = within(widget('flag')!).getByText('YELLOW');
    expect(yellow).toHaveAttribute('data-flag', 'yellow');
    expect(yellow).toHaveClass('bg-warn');

    rerender(flag('chequered', 'CHEQUERED'));
    const block = document.querySelector('[data-flag="chequered"]') as HTMLElement;
    expect(block.className).toContain('repeating-conic-gradient');
    expect(block).toHaveTextContent('CHEQUERED');

    rerender(flag(null, 'NO FLAG'));
    expect(document.querySelector('[data-flag="none"]')).toHaveTextContent('NO FLAG');
  });

  it('delta_bar: the big number and a block bar that fills from the middle towards the delta', () => {
    open({ rows: [['delta_bar']] });
    const card = widget('delta_bar')!;
    expect(within(card).getByText('-0.270')).toHaveClass('text-success');
    expect(within(card).getByText('vs best lap')).toBeInTheDocument();
    const blocks = [...card.querySelectorAll('[aria-hidden="true"] > span')];
    expect(blocks).toHaveLength(21);
    // frac 0.43 is left of the middle (faster than the best): the filled block is on the left.
    const filled = blocks.map((b, i) => (b.className.includes('bg-success') ? i : -1)).filter((i) => i >= 0);
    expect(filled.length).toBeGreaterThan(0);
    expect(Math.max(...filled)).toBeLessThan(10);
  });

  it('session: the place, the field, the class line and the time left', () => {
    open({ rows: [['session']] });
    const card = widget('session')!;
    expect(within(card).getByText('P3')).toBeInTheDocument();
    expect(within(card).getByText('/ 24')).toBeInTheDocument();
    expect(within(card).getByText('P2 in class')).toBeInTheDocument();
    expect(within(card).getByText('12:34')).toBeInTheDocument();
    expect(within(card).getByText('left')).toBeInTheDocument();
  });

  it('relative: the cars around, the player picked out', () => {
    open({ rows: [['relative']] });
    const card = widget('relative')!;
    expect(within(card).getByText('A. Rossi')).toBeInTheDocument();
    expect(within(card).getByText('+0.8')).toBeInTheDocument();
    const me = card.querySelector('[data-player="true"]') as HTMLElement;
    expect(me).toHaveTextContent('You');
    expect(me).toHaveClass('text-primary');
  });

  it('centre: the gear big, the speed and the pedals; a pedal that is hidden is not drawn', () => {
    open({ rows: [['centre']] });
    const card = widget('centre')!;
    expect(within(card).getByText('4')).toHaveClass('text-7xl');
    expect(within(card).getByText('187')).toBeInTheDocument();
    expect(within(card).getByText('km/h')).toBeInTheDocument();
    expect(within(card).getByText('THR')).toBeInTheDocument();
    expect(within(card).getByText('82%')).toBeInTheDocument();
    expect(within(card).queryByText('CLU')).toBeNull();
  });

  it('tyres: four tiles with the temperature, the state and the colours the Companion sent (COLORREF)', () => {
    open({ rows: [['tyres']] });
    const tiles = document.querySelectorAll('[data-tyre]');
    expect(tiles).toHaveLength(4);
    const fl = tiles[0] as HTMLElement;
    expect(fl).toHaveTextContent('FL');
    expect(within(fl).getByText('88°')).toHaveStyle({ color: 'rgb(255, 0, 0)' });
    expect(colorref(0x00ff00)).toBe('rgb(0, 255, 0)');
    expect(colorref(0xff0000)).toBe('rgb(0, 0, 255)');
    expect(colorref(undefined)).toBeUndefined();
  });

  it('radar: the player and every car, the threats in their colours; the spotter shows the bars', () => {
    const radar = (r: NonNullable<ReturnType<typeof sampleModel>['radar']>) => <LiveDashboard frame={sampleFrame({ model: { ...sampleModel(), radar: r }, rows: [['radar']] })} />;
    const { rerender } = render(<LiveDashboard frame={sampleFrame({ rows: [['radar']] })} />);
    const svg = widget('radar')!.querySelector('svg')!;
    expect(svg.querySelectorAll('[data-player="true"]')).toHaveLength(1);
    expect(svg.querySelector('[data-threat="alongside"]')).not.toBeNull();
    expect(svg.querySelector('[data-threat="clear"]')).not.toBeNull();

    rerender(radar({ show: 'shown', title: 'Radar', mode: 'spotter', cars: [], leftBars: 2, rightBars: 1, note: null }));
    const spot = widget('radar')!.querySelector('svg')!;
    expect(spot.querySelectorAll('[data-bar="left"]')).toHaveLength(2);
    expect(spot.querySelectorAll('[data-bar="right"]')).toHaveLength(1);

    rerender(radar({ show: 'shown', title: 'Radar', mode: 'waiting', note: 'No cars yet' }));
    expect(widget('radar')!.querySelector('svg')).toBeNull();
    expect(within(widget('radar')!).getByText('No cars yet')).toBeInTheDocument();
  });

  it('track: the share of the lap and the distance, nothing like a map', () => {
    open({ rows: [['track']] });
    const card = widget('track')!;
    expect(within(card).getByText('43%')).toBeInTheDocument();
    expect(within(card).getByText('1.9 km')).toBeInTheDocument();
    expect(card.querySelector('svg')).toBeNull();
  });

  it('a card with nothing to say draws nothing', () => {
    const model = sampleModel();
    model.fuel = elem('', 'text', { show: 'hidden' });
    model.fuelLaps = elem('', 'text', { show: 'hidden' });
    model.engine = [];
    open({ model, rows: [['fuel']] });
    expect(widget('fuel')).toBeNull();
  });
});

describe('the picture of the panel', () => {
  const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  it('shows the picture Xpeed Companion drew for this screen, as it is, and none of the page’s own cards', () => {
    open({ image });
    const picture = screen.getByTestId('live-picture');
    expect(picture).toHaveAttribute('src', image);
    expect(document.querySelectorAll('[data-widget]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-row]')).toHaveLength(0);
  });

  it('keeps the rows for a frame from an older Companion (no picture)', () => {
    open();
    expect(screen.queryByTestId('live-picture')).toBeNull();
    expect(document.querySelectorAll('[data-row]').length).toBeGreaterThan(0);
  });

  it('takes only a JPEG data URL as the picture', () => {
    expect(parseFrame(JSON.stringify({ ...sampleFrame(), image }))?.image).toBe(image);
    expect(parseFrame(JSON.stringify({ ...sampleFrame(), image: 'javascript:alert(1)' }))?.image).toBeUndefined();
    expect(parseFrame(JSON.stringify({ ...sampleFrame(), image: 7 }))?.image).toBeUndefined();
  });
});

describe('parseFrame', () => {
  it('takes a frame and drops what is not a frame, and the rows that are empty or not lists', () => {
    const json = JSON.stringify({ ...sampleFrame(), rows: [['times'], [], 'x', ['centre', 7]] });
    expect(parseFrame(json)?.rows).toEqual([['times'], ['centre']]);
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame('{"v":1,"rows":[],"model":null}')).toBeNull();
    expect(parseFrame('{"v":2,"rows":[],"model":{}}')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });
});
