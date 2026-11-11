import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let token: string | null = 'google-token';
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));
vi.mock('@/lib/trips', () => ({ publicAppUrl: () => 'https://xpeed.test' }));

import { XpeedSimApiError, listDevices, pairCommand, pairLink, requestPairingCode, revokeDevice } from './xpeed-sim-api';

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

describe('the Xpeed Sim calls', () => {
  it('asks for a pairing code with the signed-in token', async () => {
    fetchMock.mockResolvedValue(answer(200, { code: 'ABCD-2345', expiresAt: '2026-11-10T12:10:00.000Z' }));
    expect(await requestPairingCode()).toEqual({ code: 'ABCD-2345', expiresAt: '2026-11-10T12:10:00.000Z' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://xpeed.test/api/sim/codes');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer google-token');
    expect(init.cache).toBe('no-store');
  });

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
      expect(await reasonOf(() => requestPairingCode())).toBe(reason);
    }
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    expect(await reasonOf(() => listDevices())).toBe('unavailable');
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(await reasonOf(() => listDevices())).toBe('unavailable');
  });

  it('does not call the server without a signed-in person', async () => {
    token = null;
    expect(await reasonOf(() => requestPairingCode())).toBe('signin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes the command to type, with this app’s address in it', () => {
    expect(pairCommand('ABCD2345')).toBe('xpeed-sim pair --server https://xpeed.test --code ABCD2345');
  });

  it('writes the link that opens Xpeed Sim, with the address escaped', () => {
    expect(pairLink('ABCD2345')).toBe('xpeedsim://pair?server=https%3A%2F%2Fxpeed.test&code=ABCD2345');
  });
});
