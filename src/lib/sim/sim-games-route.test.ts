import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny stand-in for the database client: from('sim_games') answers what `table` holds.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
let table: Array<Record<string, unknown>> = [];
let broken = false;
const query = () => {
  let rows = () => table;
  const chain = {
    select: () => chain,
    order: () => Promise.resolve(broken ? { data: null, error: { message: 'down' } } : { data: rows(), error: null }),
    eq: (column: string, value: unknown) => {
      const before = rows;
      rows = () => before().filter((row) => row[column] === value);
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
  };
  return chain;
};
let configured = true;
vi.mock('../../../api/_backend', () => ({ openBackend: () => (configured ? { service: { from: query } } : null) }));

import games from '../../../api/sim/games';

const get = (path: string, headers: Record<string, string> = {}) => games(new Request(`https://xpeed.test${path}`, { headers }));

beforeEach(() => {
  configured = true;
  broken = false;
  table = [
    { key: 'lmu', title: 'Le Mans Ultimate', cover_type: 'image/jpeg', cover_sha256: 'a'.repeat(64), cover_bytes: jpeg.length, cover_base64: jpeg.toString('base64'), updated_at: 'x' },
    { key: 'iracing', title: 'iRacing', cover_type: 'image/jpeg', cover_sha256: 'b'.repeat(64), cover_bytes: jpeg.length, cover_base64: jpeg.toString('base64'), updated_at: 'y' },
  ];
});

describe('the games route', () => {
  it('lists the games with where to fetch each cover, without the image itself', async () => {
    const response = await get('/api/sim/games');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await response.json();
    expect(body.games.map((g: { key: string }) => g.key)).toEqual(['lmu', 'iracing']);
    expect(body.games[1]).toEqual({
      key: 'iracing',
      title: 'iRacing',
      cover: { type: 'image/jpeg', sha256: 'b'.repeat(64), bytes: jpeg.length, path: '/api/sim/games/iracing/cover' },
      updatedAt: 'y',
    });
    expect(JSON.stringify(body)).not.toContain(jpeg.toString('base64'));
  });

  it('serves a cover as the stored bytes, and 304 when the copy is current', async () => {
    const response = await get('/api/sim/games/iracing/cover');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('etag')).toBe(`"${'b'.repeat(64)}"`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    const again = await get('/api/sim/games/iracing/cover', { 'If-None-Match': `"${'b'.repeat(64)}"` });
    expect(again.status).toBe(304);
  });

  it('answers 404 for an unknown game or path, 405 for writes, 503 without a database', async () => {
    expect((await get('/api/sim/games/nope/cover')).status).toBe(404);
    expect((await get('/api/sim/games/IRACING/cover')).status).toBe(404);
    expect((await get('/api/sim/games/iracing')).status).toBe(404);
    expect((await get('/api/sim/games/../x/cover')).status).toBe(404);
    expect((await games(new Request('https://xpeed.test/api/sim/games', { method: 'POST' }))).status).toBe(405);
    broken = true;
    expect((await get('/api/sim/games')).status).toBe(503);
    configured = false;
    expect((await get('/api/sim/games')).status).toBe(503);
  });
});
