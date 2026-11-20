import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the backend: the device key (sim_authenticate_device) and the signed-in person (the token).
let device: { user_id: string; device_id: string } | null;
let rpcCalls = 0;
const people: Record<string, string> = { 'token-ana': 'user-ana', 'token-ben': 'user-ben' };
vi.mock('../../../api/_backend', () => ({
  openBackend: () => ({
    service: {
      rpc: (name: string) => {
        if (name === 'sim_authenticate_device') { rpcCalls++; return Promise.resolve({ data: device, error: null }); }
        return Promise.resolve({ data: null, error: { message: 'unexpected' } });
      },
    },
    userId: async (token: string) => people[token] ?? null,
  }),
}));

import live, { forgetLiveDevices } from '../../../api/sim/live';
import { liveHub, MAX_LIVE_BYTES } from '../../../api/sim/_live';
import { forgetLimits } from '../../../api/sim/_shared';

const URL_LIVE = 'https://xpeed.test/api/sim/live';
const KEY = { authorization: 'Bearer xpd_key' };
const ANA = { authorization: 'Bearer token-ana' };
const frame = (seq: number, extra: Record<string, unknown> = {}) => ({
  v: 1, seq, sentAt: 1_700_000_000_000, game: 'lmu', dashboard: 'race', rows: [['times'], ['session', 'flag']], model: { speedKph: 100 + seq }, ...extra,
});
const post = (payload: unknown, headers: Record<string, string> = KEY) =>
  live(new Request(URL_LIVE, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }));
const getLatest = (headers: Record<string, string> = ANA) => live(new Request(URL_LIVE, { headers }));

// The test environment's AbortSignal (jsdom's) is not the one Request wants, so the signal is put on the request afterwards:
// the route only reads `aborted` and the listeners.
const openStream = (headers: Record<string, string> = ANA, signal?: AbortSignal) => {
  const req = new Request(`${URL_LIVE}/stream`, { headers });
  if (signal) Object.defineProperty(req, 'signal', { value: signal });
  return live(req);
};

/** Reads what a stream has sent so far, waiting for `needle` to show up. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    async until(needle: string) {
      for (let i = 0; i < 100 && !text.includes(needle); i++) {
        const chunk = await r.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      return text;
    },
    /** Reads to the end; whether the stream ended. */
    async finish() {
      for (let i = 0; i < 500; i++) {
        const chunk = await r.read();
        if (chunk.done) return true;
      }
      return false;
    },
    cancel: () => r.cancel(),
  };
}

beforeEach(() => {
  forgetLimits();
  forgetLiveDevices();
  liveHub.reset();
  rpcCalls = 0;
  device = { user_id: 'user-ana', device_id: 'device-1' };
});
afterEach(() => { liveHub.reset(); });

describe('POST /api/sim/live', () => {
  it('is 401 without a key, and for an unknown or revoked one', async () => {
    expect((await post(frame(1), {})).status).toBe(401);
    device = null;
    const refused = await post(frame(1));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: 'unauthorized', retryable: false });
    expect(liveHub.latest('user-ana')).toBeNull();
  });

  it('is 405 for other methods, and has no CORS headers (not a browser)', async () => {
    expect((await live(new Request(URL_LIVE, { method: 'DELETE', headers: KEY }))).status).toBe(405);
    const ok = await post(frame(1), { ...KEY, origin: 'http://localhost' });
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is 400 for a bad body, naming what is wrong, and stores nothing', async () => {
    for (const [payload, why] of [
      ['{nope', 'invalid_json'], [frame(1, { v: 2 }), 'invalid_version'], [frame(1, { dashboard: 'x' }), 'invalid_dashboard'],
      [frame(1, { rows: [['Bad']] }), 'invalid_rows'], [frame(1, { model: 'text' }), 'invalid_model'],
    ] as const) {
      const res = await post(payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: why, retryable: false });
    }
    expect(liveHub.latest('user-ana')).toBeNull();
  });

  it('is 413 above 64 KB, and 200 just under it', async () => {
    const res = await post(frame(1, { model: { pad: 'x'.repeat(MAX_LIVE_BYTES) } }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large', retryable: false });
    expect(liveHub.latest('user-ana')).toBeNull();
    const base = JSON.stringify(frame(1, { model: { pad: '' } })).length;
    expect((await post(frame(1, { model: { pad: 'x'.repeat(MAX_LIVE_BYTES - base - 10) } }))).status).toBe(200);
  });

  it('is 200 with the number of open streams, and keeps the frame for the owner of the device', async () => {
    const first = await post(frame(1));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ viewers: 0 });
    const s1 = await openStream();
    const s2 = await openStream();
    expect(await (await post(frame(2))).json()).toEqual({ viewers: 2 });
    expect(liveHub.latest('user-ana')?.frame.model).toEqual({ speedKph: 102 });
    expect(liveHub.latest('user-ben')).toBeNull();
    await s1.body!.cancel();
    await s2.body!.cancel();
  });

  it('is 429 with Retry-After past 25 frames in a second, per device', async () => {
    for (let i = 0; i < 25; i++) expect((await post(frame(i))).status).toBe(200);
    const slow = await post(frame(26));
    expect(slow.status).toBe(429);
    expect(Number(slow.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await slow.json()).toMatchObject({ error: 'too_many_requests', retryable: true });
    // another device is not limited
    device = { user_id: 'user-ana', device_id: 'device-2' };
    forgetLiveDevices();
    expect((await post(frame(1))).status).toBe(200);
  });

  it('asks the database about a key once, not for every frame', async () => {
    for (let i = 0; i < 5; i++) await post(frame(i));
    expect(rpcCalls).toBe(1);
  });

  it('drops a late frame (seq below the last) with 200 and keeps the newer one; a restart is taken', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      await post(frame(100));
      expect((await post(frame(99, { model: { speedKph: 1 } }))).status).toBe(200);
      expect(liveHub.latest('user-ana')?.frame.seq).toBe(100);
      vi.advanceTimersByTime(11_000);
      forgetLimits();
      await post(frame(1));
      expect(liveHub.latest('user-ana')?.frame.seq).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('GET /api/sim/live', () => {
  it('is 401 without a token or with an unknown one', async () => {
    expect((await getLatest({})).status).toBe(401);
    expect((await getLatest({ authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('is 204 when there is no frame, and the frame with receivedAt when there is one', async () => {
    expect((await getLatest()).status).toBe(204);
    await post(frame(7));
    const res = await getLatest();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toMatchObject({ v: 1, seq: 7, game: 'lmu', dashboard: 'race', rows: [['times'], ['session', 'flag']], model: { speedKph: 107 } });
  });

  it('never shows another person the frame', async () => {
    await post(frame(7));
    expect((await getLatest({ authorization: 'Bearer token-ben' })).status).toBe(204);
  });

  it('is 204 once the frame is older than 30 s', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(3_000_000);
      await post(frame(1));
      vi.advanceTimersByTime(31_000);
      expect((await getLatest()).status).toBe(204);
    } finally { vi.useRealTimers(); }
  });

  it('answers the browser preflight for the app origin', async () => {
    const res = await live(new Request(URL_LIVE, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});

describe('GET /api/sim/live/stream', () => {
  it('needs the signed-in person (a device key is not one)', async () => {
    expect((await openStream({})).status).toBe(401);
    expect((await openStream({ authorization: 'Bearer xpd_key' })).status).toBe(401);
    expect(liveHub.viewers('user-ana')).toBe(0);
  });

  it('is only GET', async () => {
    expect((await live(new Request(`${URL_LIVE}/stream`, { method: 'POST', headers: ANA }))).status).toBe(405);
  });

  it('is an event stream the proxy may not buffer, and sends the latest frame at once', async () => {
    await post(frame(3));
    const res = await openStream();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const r = reader(res);
    const text = await r.until('event: frame');
    expect(text).toMatch(/event: frame\ndata: \{.*"seq":3.*"receivedAt":\d+.*\}\n\n/);
    await r.cancel();
  });

  it('says idle when nothing is fresh, then a frame when one arrives', async () => {
    const r = reader(await openStream());
    expect(await r.until('event: idle')).toContain('event: idle\ndata: {}\n\n');
    await post(frame(1));
    expect(await r.until('event: frame')).toMatch(/event: frame\ndata: .*"model":\{"speedKph":101\}/);
    await r.cancel();
  });

  it('counts viewers per owner, refuses the fifth stream with 429, and decrements on abort and on cancel', async () => {
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const open: Response[] = [];
    for (const a of aborts) open.push(await openStream(ANA, a.signal));
    expect(open.every((r) => r.status === 200)).toBe(true);
    expect(liveHub.viewers('user-ana')).toBe(4);
    const fifth = await openStream();
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get('retry-after')).toBeTruthy();
    expect(liveHub.viewers('user-ana')).toBe(4);
    // another person's streams are counted apart
    const ben = await openStream({ authorization: 'Bearer token-ben' });
    expect(ben.status).toBe(200);
    expect(liveHub.viewers('user-ben')).toBe(1);

    aborts[0].abort();
    expect(liveHub.viewers('user-ana')).toBe(3);
    await open[1].body!.cancel();
    expect(liveHub.viewers('user-ana')).toBe(2);
    expect((await openStream()).status).toBe(200);
    expect(liveHub.viewers('user-ana')).toBe(3);
    aborts.forEach((a) => a.abort());
    await ben.body!.cancel();
    expect(liveHub.viewers('user-ana')).toBe(1);
    expect(liveHub.viewers('user-ben')).toBe(0);
  });

  it('pings every 15 seconds and closes after 30 minutes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(4_000_000);
      const r = reader(await openStream());
      await r.until('event: idle');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await r.until(': ping')).toContain(': ping\n\n');
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(liveHub.viewers('user-ana')).toBe(0);
      expect(await r.finish()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
