import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { checkApkUpdate, findAppUpdate, OFFLINE_APK_URL, parseReleaseBuild, requiredBuild } from './app-update';

const mocks = vi.hoisted(() => ({ native: false, build: '58', getInfo: vi.fn() }));
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => mocks.native }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: mocks.getInfo } }));
beforeEach(() => {
  mocks.native = false;
  mocks.build = '58';
  mocks.getInfo.mockImplementation(async () => ({ build: mocks.build, version: `0.1.${mocks.build}` }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ body: 'Build 70 from main @ abc1234. Native build 58 @ def5678.' }) }));
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, hostname: 'xpeed.skale.club' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('app update check', () => {
  it('reads the build number CI writes in the release notes', () => {
    expect(parseReleaseBuild('Build 42 from feat/android-app @ 2d1e4b0. Install on Android: …')).toBe(42);
    expect(parseReleaseBuild('no number here')).toBeNull();
    expect(parseReleaseBuild(null)).toBeNull();
  });

  it('asks the live-site app to update only for native changes', () => {
    const notes = 'Build 57 from main @ abc1234. Native build 52 @ def5678. Install on Android: …';
    expect(parseReleaseBuild(notes)).toBe(57);
    expect(requiredBuild(notes, true)).toBe(52); // web changes since 52 arrive with the site
    expect(requiredBuild(notes, false)).toBe(57); // the offline APK needs every build
    // Missing metadata cannot establish that a native update is required.
    expect(requiredBuild('Build 42 from main @ 2d1e4b0.', true)).toBeNull();
    expect(requiredBuild('Uploading build 71...', true)).toBeNull();
  });

  it('never reports an update outside the Android app', async () => {
    expect(await findAppUpdate()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not offer a new APK for newer screens when the installed native build is current', async () => {
    mocks.native = true;
    expect(await checkApkUpdate(true)).toMatchObject({ installed: 58, required: 58, latest: 70, available: false });
  });

  it('requires an APK when the installed native build is too old', async () => {
    mocks.native = true; mocks.build = '57';
    expect(await checkApkUpdate(true)).toMatchObject({ installed: 57, required: 58, latest: 70, available: true });
  });

  it('keeps the installed version visible offline without making a release request', async () => {
    mocks.native = true;
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await checkApkUpdate(true)).toMatchObject({ installed: 58, installedVersion: '0.1.58', required: null, available: false });
    expect(fetch).not.toHaveBeenCalled(); online.mockRestore();
  });

  it('offers the matching offline package for an offline installation', async () => {
    mocks.native = true;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, hostname: 'localhost' } });
    expect(await checkApkUpdate(true)).toMatchObject({ bundled: true, required: 70, available: true, downloadUrl: OFFLINE_APK_URL });
  });

  it('does not turn unknown native metadata or a failed check into an APK prompt', async () => {
    mocks.native = true;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ body: 'Build 70 from main @ abc1234.' }) } as Response);
    expect(await checkApkUpdate(true)).toMatchObject({ required: null, available: false });
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    expect(await checkApkUpdate(true)).toMatchObject({ installed: 58, installedVersion: '0.1.58', required: null, available: false });
  });
});
