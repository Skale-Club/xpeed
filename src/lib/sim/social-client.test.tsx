import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesOf } from '@/lib/sim/read-lap-file';
import { V1Error } from '@/lib/sim/v1-client';
import {
  DELETE_SENTENCE, cleanName, deleteMyRacingData, driverPath, exportMyData, fetchPublicShare, fetchPublicShareFile, leaderboardPath, profileFieldOf,
  sharePagePath, socialErrorKey,
} from '@/lib/sim/social-client';
import { fakeSocialFetch, fakeSocialState } from '@/test/social-fake-server';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'secret-token' }));

afterEach(() => vi.unstubAllGlobals());

const error = (status: number, code: string, retryable = false) => new V1Error(status, code, retryable);

describe('the social client: errors', () => {
  it('maps every social error code to a sentence of its own', () => {
    const codes = [
      'invalid_handle', 'reserved_handle', 'handle_taken', 'handle_change_limit', 'invalid_display_name', 'invalid_visibility', 'handle_not_found',
      'profile_not_found', 'request_not_found', 'friend_not_found', 'share_not_found', 'target_not_found', 'report_not_found', 'lap_not_found',
      'session_not_found', 'already_friends', 'already_requested', 'blocked', 'already_reported', 'already_decided', 'friend_limit', 'pending_limit',
      'share_limit', 'too_many_open_reports', 'too_many_requests', 'invalid_target', 'invalid_details', 'invalid_reason', 'invalid_expires',
      'confirmation_required', 'forbidden',
    ];
    for (const code of codes) expect(socialErrorKey(error(409, code))).toBe(code);
  });

  it('says "signed out" for a 401, "offline" when the server cannot be reached, "unavailable" for an outage and "generic" otherwise', () => {
    expect(socialErrorKey(error(401, 'unauthorized'))).toBe('signedOut');
    expect(socialErrorKey(error(0, 'network', true))).toBe('offline');
    expect(socialErrorKey(error(503, 'unavailable', true))).toBe('unavailable');
    expect(socialErrorKey(error(400, 'something_new'))).toBe('generic');
    expect(socialErrorKey(new Error('boom'))).toBe('generic');
  });

  it('knows which profile field an error is about', () => {
    expect(profileFieldOf(error(409, 'handle_taken'))).toBe('handle');
    expect(profileFieldOf(error(400, 'reserved_handle'))).toBe('handle');
    expect(profileFieldOf(error(429, 'handle_change_limit', true))).toBe('handle');
    expect(profileFieldOf(error(400, 'invalid_display_name'))).toBe('displayName');
    expect(profileFieldOf(error(400, 'invalid_visibility'))).toBe('visibility');
    expect(profileFieldOf(error(503, 'unavailable', true))).toBeNull();
  });
});

describe('the social client: the public share fetch', () => {
  it('sends no Authorization header, no cookies and no body', async () => {
    const state = fakeSocialState();
    state.publicTokens.set('abc', { kind: 'lap', createdAt: '2026-11-13T10:00:00.000Z', expiresAt: null, driver: null, lap: { id: 'l1', game: 'lmu', track: { name: 'Monza', lengthM: 5793 }, car: { name: 'Ferrari 499P', class: null }, lapNumber: 3, timeMs: 99_500, valid: true, startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: null, topSpeedKmh: null } });
    const spy = vi.fn(fakeSocialFetch(state));
    vi.stubGlobal('fetch', spy);
    const share = await fetchPublicShare('abc');
    expect(share.kind).toBe('lap');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sim/public/share/abc');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
    expect(state.requests[0].authorization).toBeNull();
  });

  it('sends no Authorization header for the lap file either', async () => {
    const state = fakeSocialState();
    state.publicTokens.set('abc', { kind: 'lap', createdAt: '', expiresAt: null, driver: null, lap: { id: 'l1', game: 'lmu', track: { name: 'M', lengthM: null }, car: { name: 'C', class: null }, lapNumber: 1, timeMs: 1, valid: true, startedAt: '', sectorsMs: null, topSpeedKmh: null } });
    state.publicFiles.set('l1', new Uint8Array([1, 2, 3]));
    const spy = vi.fn(fakeSocialFetch(state));
    vi.stubGlobal('fetch', spy);
    const blob = await fetchPublicShareFile('abc', 'l1');
    expect(blob.size).toBe(3);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sim/public/share/abc/file/l1');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it('answers a link that is not available with a 404 not_found', async () => {
    vi.stubGlobal('fetch', vi.fn(fakeSocialFetch(fakeSocialState())));
    await expect(fetchPublicShare('nope')).rejects.toMatchObject({ status: 404, code: 'not_found', retryable: false });
  });

  it('turns a failure to reach the server into a retryable network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(fetchPublicShare('abc')).rejects.toMatchObject({ status: 0, code: 'network', retryable: true });
  });
});

describe('the social client: signed-in calls', () => {
  it('sends the sign-in token and a JSON body, and asks to delete only with the exact sentence', async () => {
    const state = fakeSocialState();
    vi.stubGlobal('fetch', vi.fn(fakeSocialFetch(state)));
    const summary = await deleteMyRacingData();
    expect(summary.profile).toBe(1);
    const call = state.requests.find((request) => request.path === '/me/data')!;
    expect(call.method).toBe('DELETE');
    expect(call.authorization).toBe('Bearer secret-token');
    expect(call.body).toEqual({ confirm: DELETE_SENTENCE });
    expect(DELETE_SENTENCE).toBe('delete my racing data');
  });

  it('reads the export as a blob of JSON', async () => {
    const state = fakeSocialState();
    vi.stubGlobal('fetch', vi.fn(fakeSocialFetch(state)));
    const blob = await exportMyData();
    const text = new TextDecoder().decode(await bytesOf(blob));
    expect(JSON.parse(text)).toMatchObject({ format: 'xpeed-virtual-export', version: 1 });
  });
});

describe('the social client: names and paths', () => {
  it('never lets a name that looks like an e-mail address or a phone number through', () => {
    expect(cleanName('  Ana  ')).toBe('Ana');
    expect(cleanName(null)).toBeNull();
    expect(cleanName('')).toBeNull();
    expect(cleanName('ana@example.com')).toBeNull();
    expect(cleanName('call +55 11 91234-5678')).toBeNull();
    expect(cleanName('11912345678')).toBeNull();
    expect(cleanName('Racer 99')).toBe('Racer 99');
  });

  it('builds the addresses of the screens', () => {
    expect(driverPath('lap_fan')).toBe('/virtual/drivers/lap_fan');
    expect(sharePagePath('a-b_c')).toBe('/s/a-b_c');
    expect(leaderboardPath()).toBe('/virtual/leaderboards');
    expect(leaderboardPath({ track: 't1', car: 'c1', scope: 'friends' })).toBe('/virtual/leaderboards?track=t1&car=c1&scope=friends');
  });
});
