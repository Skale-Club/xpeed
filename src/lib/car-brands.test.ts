import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCarBrands, normalizeCarBrand, resolveCarBrand, type CarBrand } from './car-brands';

const brands = [
  { key: 'toyota', name: 'Toyota', aliases: [], logo: { type: 'image/png', sha256: '1'.repeat(64), bytes: 120, path: 'toyota.png' } },
  { key: 'citroen', name: 'Citroën', aliases: [], logo: { type: 'image/png', sha256: '2'.repeat(64), bytes: 120, path: 'citroen.png' } },
  { key: 'volkswagen', name: 'Volkswagen', aliases: ['VW'], logo: { type: 'image/png', sha256: '3'.repeat(64), bytes: 120, path: 'volkswagen.png' } },
  { key: 'chery', name: 'Chery', aliases: ['CAOA Chery'], logo: { type: 'image/png', sha256: '4'.repeat(64), bytes: 120, path: 'chery.png' } },
  { key: 'lexus', name: 'Lexus', aliases: [], logo: { type: 'image/png', sha256: '5'.repeat(64), bytes: 120, path: 'lexus.png' } },
  { key: 'bmw', name: 'BMW', aliases: [], logo: { type: 'image/png', sha256: '6'.repeat(64), bytes: 120, path: 'bmw.png' } },
  { key: 'bmw-m', name: 'BMW M', aliases: [], logo: { type: 'image/png', sha256: '7'.repeat(64), bytes: 120, path: 'bmw-m.png' } },
] satisfies CarBrand[];

afterEach(() => vi.unstubAllGlobals());

describe('car brand matching', () => {
  it('normalizes accents and punctuation and matches saved makes or explicit aliases exactly', () => {
    expect(normalizeCarBrand('CITROËN S.A.')).toBe('citroensa');
    expect(normalizeCarBrand('比亚迪')).toBe('比亚迪');
    expect(resolveCarBrand('未知品牌', brands)).toBeUndefined();
    expect(resolveCarBrand('Toyota', brands)?.key).toBe('toyota');
    expect(resolveCarBrand('Citroen', brands)?.key).toBe('citroen');
    expect(resolveCarBrand('VW', brands)?.key).toBe('volkswagen');
    expect(resolveCarBrand('CAOA Chery', brands)?.key).toBe('chery');
  });

  it('keeps similar marques separate and never uses partial matching', () => {
    expect(resolveCarBrand('Lexus', brands)?.key).toBe('lexus');
    expect(resolveCarBrand('Lexus', brands)?.key).not.toBe('toyota');
    expect(resolveCarBrand('BMW M', brands)?.key).toBe('bmw-m');
    expect(resolveCarBrand('BMW', brands)?.key).toBe('bmw');
    expect(resolveCarBrand('BMW M Performance', brands)).toBeUndefined();
    expect(resolveCarBrand('Toyota Corolla', brands)).toBeUndefined();
    expect(resolveCarBrand(null, brands)).toBeUndefined();
  });
});

describe('fetchCarBrands', () => {
  it('accepts the PNG catalog shape and rejects malformed rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ brands }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCarBrands()).resolves.toEqual(brands);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ brands: [{ ...brands[0], aliases: [null] }] }) }));
    await expect(fetchCarBrands()).rejects.toThrow('Invalid car brand catalog');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ brands: [{ ...brands[0], logo: { ...brands[0].logo, sha256: 'bad' } }] }) }));
    await expect(fetchCarBrands()).rejects.toThrow('Invalid car brand catalog');
  });
});
