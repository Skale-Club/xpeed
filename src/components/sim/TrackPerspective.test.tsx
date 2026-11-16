import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import type { LapFile } from '@/lib/sim/lap-file';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { TrackPerspective } from './TrackPerspective';

const lap: LapFile = {
  header: { game: 'ac', track: { name: 'Test Track' }, car: { name: 'Test Car' }, lap: { number: 1, timeMs: 2000, valid: true }, startedAt: '2026-01-01T00:00:00Z', sampleRateHz: 10, sampleCount: 21, channels: ['t', 'dist', 'x', 'z'].map(id => ({ id, unit: id === 't' ? 's' : 'm' })) },
  data: { t: Float32Array.from({ length: 21 }, (_, i) => i / 10), dist: Float32Array.from({ length: 21 }, (_, i) => i * 5), x: new Float32Array(21), z: Float32Array.from({ length: 21 }, (_, i) => i * 5) },
};
let callbacks: Map<number, FrameRequestCallback>, nextId: number;
const tick = (time: number) => act(() => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(fn => fn(time)); });
const mount = (props: Partial<Parameters<typeof TrackPerspective>[0]> = {}) => render(<SettingsProvider><TrackPerspective lap={lap} {...props} /></SettingsProvider>);

beforeEach(async () => {
  await i18n.changeLanguage('en'); localStorage.clear(); callbacks = new Map(); nextId = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { callbacks.set(++nextId, cb); return nextId; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('perspective lap playback', () => {
  it('starts paused with an upward opaque arrow outside the screen-space ground mask', () => {
    const { container } = mount();
    expect(screen.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    expect(callbacks.size).toBe(0);
    expect(screen.getByTestId('perspective-car').parentElement).toBe(screen.getByTestId('perspective-svg'));
    const mask = container.querySelector('mask')!;
    expect(mask).toHaveAttribute('maskUnits', 'userSpaceOnUse'); expect(mask).toHaveAttribute('height', '400');
    expect(container.querySelector('linearGradient')).toHaveAttribute('y2', '400');
    expect(screen.queryByTestId('perspective-road')).not.toBeInTheDocument();
    expect(screen.getByText('Recorded path; road edges unavailable')).toBeInTheDocument();
  });

  it('plays real elapsed time from frame zero, pauses/resumes, and stops finitely', () => {
    mount(); const svg = screen.getByTestId('perspective-svg');
    fireEvent.click(screen.getByRole('button', { name: 'Play', exact: true })); tick(0); tick(500);
    expect(Number(svg.getAttribute('data-time'))).toBeCloseTo(.5);
    fireEvent.click(screen.getByRole('button', { name: 'Pause', exact: true })); expect(callbacks.size).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play', exact: true })); tick(1000); tick(1500);
    expect(Number(svg.getAttribute('data-time'))).toBeCloseTo(1);
    tick(4000); expect(screen.getByRole('button', { name: 'Replay', exact: true })).toBeInTheDocument(); expect(callbacks.size).toBe(0);
  });

  it('scrubs, adjusts camera controls, and focuses the nearest recorded point', () => {
    const { rerender } = mount();
    fireEvent.change(screen.getByRole('slider', { name: 'Lap playback position' }), { target: { value: '1' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Camera below horizon' }), { target: { value: '25' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '1.4' } });
    expect(screen.getByTestId('perspective-svg')).toHaveAttribute('data-tilt', '25');
    rerender(<SettingsProvider><TrackPerspective lap={lap} focus={{ key: 1, x: 0, z: 75 }} /></SettingsProvider>);
    expect(Number(screen.getByTestId('perspective-svg').getAttribute('data-time'))).toBeCloseTo(1.5);
  });

  it('cancels animation on unmount and uses distinct masks for multiple views', () => {
    const first = mount(), second = mount();
    const maskIds = screen.getAllByTestId('perspective-ground').map(p => p.getAttribute('mask'));
    expect(new Set(maskIds).size).toBe(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Play', exact: true })[0]); expect(callbacks.size).toBe(1);
    first.unmount(); expect(callbacks.size).toBe(0); second.unmount();
  });

  it('shows missing positions honestly and does not draw an invented road', () => {
    mount({ lap: { ...lap, data: { t: lap.data.t, dist: lap.data.dist } } });
    expect(screen.getByText('Position is unavailable at this moment.')).toBeInTheDocument();
    expect(screen.queryByTestId('perspective-car')).not.toBeInTheDocument(); expect(screen.queryByTestId('perspective-road')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  });
});
