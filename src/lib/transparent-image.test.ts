import { expect, it } from 'vitest';
import { hasTransparentPixels } from './transparent-image';

it('accepts images with transparent pixels and rejects opaque or nearly transparent pixels', () => {
  expect(hasTransparentPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]))).toBe(true);
  expect(hasTransparentPixels(new Uint8ClampedArray([0, 0, 0, 255]))).toBe(false);
  expect(hasTransparentPixels(new Uint8ClampedArray([0, 0, 0, 17]))).toBe(false);
});
