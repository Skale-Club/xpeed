import { beforeEach, describe, expect, it, vi } from 'vitest';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let table: Array<Record<string, unknown>> = [];
let broken = false;
const query = () => {
  let rows = () => table;
  const chain = {
    select: () => chain,
    order: () => Promise.resolve(broken ? { data: null, error: { message: 'database detail must not leak' } } : { data: rows(), error: null }),
    eq: (column: string, value: unknown) => {
      const before = rows;
      rows = () => before().filter((row) => row[column] === value);
      return chain;
    },
    maybeSingle: () => Promise.resolve(broken ? { data: null, error: { message: 'database detail must not leak' } } : { data: rows()[0] ?? null, error: null }),
  };
  return chain;
};
let configured = true;
vi.mock('../../api/_backend', () => ({ openBackend: () => (configured ? { service: { from: query } } : null) }));

import carBrands from '../../api/car-brands';

const get = (path: string, headers: Record<string, string> = {}) => carBrands(new Request(`https://xpeed.test${path}`, { headers }));

beforeEach(() => {
  configured = true;
  broken = false;
  table = [{
    key: 'alfa-romeo', name: 'Alfa Romeo', aliases: ['Alfa'], logo_type: 'image/png',
    logo_sha256: 'a'.repeat(64), logo_bytes: png.length, logo_base64: png.toString('base64'),
    source_url: 'https://example.test/alfa.svg',
  }];
});

describe('car brands route', () => {
  it('lists brand metadata and a logo path without embedding the image', async () => {
    const response = await get('/api/car-brands');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await response.json();
    expect(body.brands).toEqual([{
      key: 'alfa-romeo', name: 'Alfa Romeo', aliases: ['Alfa'],
      logo: { type: 'image/png', sha256: 'a'.repeat(64), bytes: png.length, path: '/api/car-brands/alfa-romeo/logo' },
      sourceUrl: 'https://example.test/alfa.svg',
    }]);
    expect(JSON.stringify(body)).not.toContain(png.toString('base64'));
  });

  it('serves PNG bytes with an ETag and answers 304 for a current copy', async () => {
    const response = await get('/api/car-brands/alfa-romeo/logo');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await get('/api/car-brands/alfa-romeo/logo', { 'If-None-Match': `"${'a'.repeat(64)}"` })).status).toBe(304);
  });

  it('rejects malformed paths and methods and returns generic database errors', async () => {
    expect((await get('/api/car-brands/')).status).toBe(200);
    expect((await get('/api/car-brands/alfa-romeo/logo/')).status).toBe(404);
    expect((await get('/api/car-brands/Alfa/logo')).status).toBe(404);
    expect((await get('/api/car-brands/a%2Fb/logo')).status).toBe(404);
    expect((await get('/api/car-brands/missing/logo')).status).toBe(404);
    expect((await carBrands(new Request('https://xpeed.test/api/car-brands', { method: 'POST' }))).status).toBe(405);
    expect((await carBrands(new Request('https://xpeed.test/api/car-brands', { method: 'OPTIONS' }))).status).toBe(204);
    broken = true;
    const failed = await get('/api/car-brands');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('database detail');
    configured = false;
    expect((await get('/api/car-brands')).status).toBe(503);
  });
});
