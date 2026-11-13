import { describe, expect, it } from 'vitest';
import type { CarBrand } from '@/lib/car-brands';
import { resolveVirtualCarBrand } from './car-brand';

const brand = (key: string, name: string, aliases: string[] = []): CarBrand => ({
  key, name, aliases, logo: { type: 'image/png', sha256: 'a'.repeat(64), bytes: 1, path: `/api/car-brands/${key}/logo` },
});
const brands = [brand('mercedes-benz', 'Mercedes-Benz', ['Mercedes']), brand('ford', 'Ford'), brand('toyota', 'Toyota'), brand('ferrari', 'Ferrari')];

describe('resolveVirtualCarBrand', () => {
  it('matches exact names and aliases, preferring the longest prefix', () => {
    expect(resolveVirtualCarBrand('Ford GT', brands)?.key).toBe('ford');
    expect(resolveVirtualCarBrand('Mercedes-AMG GT3', brands)?.key).toBe('mercedes-benz');
    expect(resolveVirtualCarBrand('Mercedes-Benz 190E', brands)?.key).toBe('mercedes-benz');
  });
  it('recognizes only the explicitly mapped short racing models', () => {
    expect(resolveVirtualCarBrand('GR010 Hybrid', brands)?.key).toBe('toyota');
    expect(resolveVirtualCarBrand('499P', brands)?.key).toBe('ferrari');
  });
  it('requires a word boundary and leaves ambiguous names generic', () => {
    expect(resolveVirtualCarBrand('Fordham GT', brands)).toBeUndefined();
    expect(resolveVirtualCarBrand('Sample Car', brands)).toBeUndefined();
    expect(resolveVirtualCarBrand('Forza car123', brands)).toBeUndefined();
  });
});
