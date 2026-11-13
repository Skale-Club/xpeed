import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let token: string | null = 'google-token';
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));
vi.mock('@/lib/trips', () => ({ publicAppUrl: () => 'https://xpeed.test' }));

import { XpeedSimApiError, XpeedSimLinkError, approveLinkRequest, cancelLinkRequest, listDevices, readLinkRequest, revokeDevice } from './xpeed-sim-api';

const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reasonOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof XpeedSimApiError ? error.reason : `other: ${String(error)}`;
  }
  return 'no error';
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  token = 'google-token';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('the Xpeed Companion calls', () => {
  it('lists the devices, and an empty answer is an empty list', async () => {
    const device = { id: 'd1', name: 'RIG', created_at: 'x', last_seen_at: null, last_lap_at: null, revoked_at: null };
    fetchMock.mockResolvedValueOnce(answer(200, { devices: [device] })).mockResolvedValueOnce(answer(200, {}));
    expect(await listDevices()).toEqual([device]);
    expect(await listDevices()).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://xpeed.test/api/sim/devices');
  });

  it('revokes one device, escaping its id', async () => {
    fetchMock.mockResolvedValue(answer(200, { revoked: true }));
    await revokeDevice('a b&c');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://xpeed.test/api/sim/devices?id=a%20b%26c');
    expect(init.method).toBe('DELETE');
  });

  it('tells what went wrong in a few reasons', async () => {
    for (const [status, reason] of [[401, 'signin'], [429, 'too_many'], [404, 'not_found'], [500, 'unavailable'], [503, 'unavailable']] as const) {
      fetchMock.mockResolvedValueOnce(answer(status));
      expect(await reasonOf(() => listDevices())).toBe(reason);
    }
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    expect(await reasonOf(() => listDevices())).toBe('unavailable');
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(await reasonOf(() => listDevices())).toBe('unavailable');
  });

  it('does not call the server without a signed-in person', async () => {
    token = null;
    expect(await reasonOf(() => listDevices())).toBe('signin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads, approves and cancels a connection request with the signed-in token', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { deviceName: 'RIG', status: 'pending', expiresAt: '2026-11-13T12:10:00.000Z' }))
      .mockResolvedValueOnce(answer(200, { status: 'approved', deviceId: 'd1' }))
      .mockResolvedValueOnce(answer(200, { status: 'cancelled' }));
    expect(await readLinkRequest('abc')).toEqual({ deviceName: 'RIG', status: 'pending', expiresAt: '2026-11-13T12:10:00.000Z' });
    expect(await approveLinkRequest('abc')).toEqual({ status: 'approved', deviceId: 'd1' });
    expect(await cancelLinkRequest('abc')).toEqual({ status: 'cancelled' });
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init.method, init.headers.Authorization]);
    expect(calls).toEqual([
      ['https://xpeed.test/api/sim/link/abc', 'GET', 'Bearer google-token'],
      ['https://xpeed.test/api/sim/link/abc/approve', 'POST', 'Bearer google-token'],
      ['https://xpeed.test/api/sim/link/abc/cancel', 'POST', 'Bearer google-token'],
    ]);
  });

  it('tells why a connection request could not be approved', async () => {
    const why = async (response: Response) => {
      fetchMock.mockResolvedValueOnce(response);
      try {
        await approveLinkRequest('abc');
      } catch (error) {
        return error instanceof XpeedSimLinkError ? error.reason : 'other';
      }
      return 'no error';
    };
    expect(await why(answer(410, { error: 'expired' }))).toBe('expired');
    expect(await why(answer(409, { error: 'device_limit' }))).toBe('device_limit');
    expect(await why(answer(409, { error: 'already_decided' }))).toBe('already_decided');
    expect(await why(answer(404, { error: 'not_found' }))).toBe('not_found');
    expect(await why(answer(401))).toBe('signin');
    expect(await why(answer(503))).toBe('unavailable');
    token = null;
    expect(await why(answer(200))).toBe('signin');
  });
});
