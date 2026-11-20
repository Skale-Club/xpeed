import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipLap } from './lap-file';

// A stand-in for the backend: the device key, the reference function and the lap storage.
let device: { user_id: string; device_id: string } | null;
let picked: { data: unknown; error: unknown };
let stored: Uint8Array | null;
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let downloads = 0;
vi.mock('../../../api/_backend', () => ({
  openBackend: () => ({
    service: {
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'sim_authenticate_device') return Promise.resolve({ data: device, error: null });
        if (name === 'sim_reference_lap') return Promise.resolve(picked);
        return Promise.resolve({ data: null, error: { message: 'unexpected' } });
      },
      storage: {
        from: () => ({
          download: () => {
            downloads++;
            return Promise.resolve(stored ? { data: new Blob([stored]), error: null } : { data: null, error: { statusCode: '404' } });
          },
        }),
      },
    },
  }),
}));

import reference from '../../../api/sim/reference';
import { forgetLimits } from '../../../api/sim/_shared';
import { referencePoints } from '../../../api/sim/_reference';

const LAP = '11111111-2222-4333-8444-555555555555';
const KEY = { authorization: 'Bearer xpd_key' };
const get = (query: string, headers: Record<string, string> = KEY) =>
  reference(new Request(`https://xpeed.test/api/sim/reference?${query}`, { headers }));
const Q = 'game=lmu&track=Test%20Track&car=Test%20Car';

const lapFile = (t: number[], dist: number[]) => gzipLap({
  header: {
    game: 'lmu', track: { name: 'Test Track' }, car: { name: 'Test Car' }, lap: { number: 1, timeMs: 1000, valid: true },
    startedAt: '2026-11-10T12:00:00.000Z', sampleRateHz: 2, sampleCount: t.length, channels: [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }],
  },
  data: { t: new Float32Array(t), dist: new Float32Array(dist) },
});

beforeEach(async () => {
  forgetLimits();
  rpcCalls.length = 0;
  downloads = 0;
  device = { user_id: 'user-1', device_id: 'device-1' };
  picked = { data: { kind: 'best', lapId: LAP, timeMs: 1000, recordedAt: '2026-11-10T12:00:00.000Z', driver: 'Ana', storagePath: 'user-2/x.xlap.gz' }, error: null };
  stored = await lapFile([0, 0.5, 1], [0, 10, 20]);
});

describe('referencePoints', () => {
  it('gives the time at every 5 m by linear interpolation', () => {
    expect(referencePoints([0, 0.5, 1], [0, 10, 20])).toEqual([0, 250, 500, 750, 1000]);
  });

  it('ignores samples whose distance goes backwards or stands still, so the trace always increases', () => {
    // 12 m after 15 m (backwards) and the repeated 15 m are dropped: the samples used are 0 m, 10 m, 15 m and 20 m.
    expect(referencePoints([0, 1, 2, 2.5, 3, 4], [0, 10, 15, 12, 15, 20])).toEqual([0, 500, 1000, 2000, 4000]);
  });

  it('ignores samples the game did not give (NaN) and stops at the last sample', () => {
    expect(referencePoints([0, NaN, 1, 2], [0, 5, 7, 12])).toEqual([0, 714, 1600]); // 0, 5 and 10 m; the lap ends at 12 m
  });

  it('starts at the first sample when the lap begins past 0 m, and is empty for a lap too short to use', () => {
    expect(referencePoints([1, 2], [5, 15])).toEqual([1000, 1000, 1500, 2000]);
    expect(referencePoints([0], [0])).toEqual([]);
    expect(referencePoints([0, 1], [0, 0])).toEqual([]);
  });

  it('stays compact: a 6 km lap is about 1200 points', () => {
    const n = 6000;
    expect(referencePoints(Array.from({ length: n + 1 }, (_, i) => i / 50), Array.from({ length: n + 1 }, (_, i) => i)).length).toBe(1201);
  });
});

describe('GET /api/sim/reference', () => {
  it('needs a device key: none or an unknown one is 401', async () => {
    expect((await get(Q, {})).status).toBe(401);
    device = null;
    expect((await get(Q)).status).toBe(401);
    expect(rpcCalls.some((c) => c.name === 'sim_reference_lap')).toBe(false);
  });

  it('is GET only', async () => {
    expect((await reference(new Request(`https://xpeed.test/api/sim/reference?${Q}`, { method: 'POST', headers: KEY }))).status).toBe(405);
  });

  it('refuses bad or missing parameters with 400 and never reaches the database', async () => {
    const bad = [
      'track=T&car=C', 'game=LMU&track=T&car=C', `${Q}&kind=fastest`, 'game=lmu&car=C', 'game=lmu&track=T',
      `game=lmu&track=${'x'.repeat(121)}&car=C`, `${Q}&variant=${'v'.repeat(121)}`, 'game=lmu&track=a%00b&car=C',
    ];
    for (const query of bad) {
      const r = await get(query);
      expect(r.status, query).toBe(400);
      expect(typeof (await r.json()).error).toBe('string');
    }
    expect(rpcCalls.some((c) => c.name === 'sim_reference_lap')).toBe(false);
  });

  it('answers with the lap, its points, the ETag and the cache header', async () => {
    const r = await get(`${Q}&variant=GP&kind=best`);
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe(`"${LAP}"`);
    expect(r.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await r.json()).toEqual({ kind: 'best', lapId: LAP, timeMs: 1000, driver: 'Ana', recordedAt: '2026-11-10T12:00:00.000Z', stepM: 5, points: [0, 250, 500, 750, 1000] });
  });

  it('asks the database as the device owner, names as parameters, best as the default kind', async () => {
    await get('game=lmu&track=Spa%27%3B%20DROP&car=Test%20Car');
    const call = rpcCalls.find((c) => c.name === 'sim_reference_lap')!;
    expect(call.args).toEqual({ p_user: 'user-1', p_game: 'lmu', p_track: "Spa'; DROP", p_car: 'Test Car', p_kind: 'best' });
    await get(`${Q}&kind=personal`);
    expect(rpcCalls.filter((c) => c.name === 'sim_reference_lap')[1].args.p_kind).toBe('personal');
  });

  it('says the kind of the lap that came back, with no driver for the owner\'s own lap', async () => {
    picked = { data: { kind: 'personal', lapId: LAP, timeMs: 1000, recordedAt: 'x', driver: null, storagePath: 'user-1/x.xlap.gz' }, error: null };
    const body = await (await get(Q)).json();
    expect(body.kind).toBe('personal');
    expect(body.driver).toBeNull();
  });

  it('is 404 no_reference when there is no lap, the file is gone, or the lap has no usable distance', async () => {
    picked = { data: null, error: null };
    const r = await get(Q);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('no_reference');
    picked = { data: { kind: 'best', lapId: LAP, timeMs: 1, recordedAt: 'x', driver: null, storagePath: 'p' }, error: null };
    stored = null;
    expect((await get(Q)).status).toBe(404);
    stored = await lapFile([0, 1], [0, 0]);
    expect((await get(Q)).status).toBe(404);
  });

  it('is 304 without reading the file when If-None-Match is the lap\'s ETag', async () => {
    const r = await get(Q, { ...KEY, 'if-none-match': `W/"other", "${LAP}"` });
    expect(r.status).toBe(304);
    expect(await r.text()).toBe('');
    expect(r.headers.get('etag')).toBe(`"${LAP}"`);
    expect(downloads).toBe(0);
    expect((await get(Q, { ...KEY, 'if-none-match': '"other"' })).status).toBe(200);
  });

  it('is 429 after 30 requests a minute from one device', async () => {
    for (let i = 0; i < 30; i++) expect((await get(Q)).status).toBe(200);
    const r = await get(Q);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    device = { user_id: 'user-1', device_id: 'device-2' };
    expect((await get(Q)).status).toBe(200);
  });

  it('is 503 and retryable when the database fails', async () => {
    picked = { data: null, error: { message: 'down' } };
    const r = await get(Q);
    expect(r.status).toBe(503);
    expect((await r.json()).retryable).toBe(true);
  });
});
