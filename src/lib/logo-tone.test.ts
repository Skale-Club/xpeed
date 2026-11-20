import { describe, expect, it } from 'vitest';
import { logoTone, logoToneFilter } from './logo-tone';

/** RGBA pixels: `count` of each colour, all opaque, plus some transparent ones that must not count. */
function pixels(...runs: Array<[number, number, number, number]>): number[] {
  const out: number[] = [];
  for (const [r, g, b, count] of runs) for (let i = 0; i < count; i += 1) out.push(r, g, b, 255);
  for (let i = 0; i < 50; i += 1) out.push(255, 255, 255, 0);
  return out;
}

describe('logoTone', () => {
  it('turns a black or grey one-colour logo white on the dark tile', () => {
    expect(logoTone(pixels([0, 0, 0, 100]))).toBe('mono');
    expect(logoTone(pixels([128, 128, 128, 100]))).toBe('mono');
    expect(logoToneFilter('mono')).toBe('brightness(0) invert(1)');
  });

  it('leaves a light one-colour logo as it is', () => {
    expect(logoTone(pixels([230, 230, 230, 100]))).toBe('plain');
  });

  it('brightens a dark logo with its own colours instead of whitening it', () => {
    expect(logoTone(pixels([0, 30, 80, 80], [255, 255, 255, 20]))).toBe('dark');
    expect(logoToneFilter('dark')).toContain('brightness');
  });

  it('keeps a small coloured emblem inside a grey ring in its colours', () => {
    expect(logoTone(pixels([150, 150, 150, 50], [40, 40, 40, 30], [220, 40, 40, 20]))).toBe('plain');
  });

  it('shows a colourful or empty logo as it is', () => {
    expect(logoTone(pixels([220, 30, 30, 60], [250, 200, 0, 40]))).toBe('plain');
    expect(logoTone([])).toBe('plain');
    expect(logoToneFilter(undefined)).toBeUndefined();
  });
});
