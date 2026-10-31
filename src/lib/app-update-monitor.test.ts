import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ native: true, check: vi.fn() }));
vi.mock('./app-update', () => ({ checkApkUpdate: h.check }));
vi.mock('./obd/native-ble', () => ({ isNativeApp: () => h.native }));
const release = { installed: 76, installedVersion: '1.0.76', required: 77, latest: 79, available: true, bundled: false, downloadUrl: '/xpeed.apk' };
const cleanups: (() => void)[] = [];
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); h.native = true; h.check.mockReset().mockResolvedValue(release); });
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
it('shares the automatic check and polling timer between About and the global notice', async () => {
  const mod = await import('./app-update-monitor');
  cleanups.push(mod.subscribeAppUpdates(vi.fn()), mod.subscribeAppUpdates(vi.fn()));
  await settle(); expect(h.check).toHaveBeenCalledOnce();
  expect(mod.getAppUpdateSnapshot().update).toEqual(release);
  await vi.advanceTimersByTimeAsync(mod.APK_CHECK_INTERVAL_MS);
  expect(h.check).toHaveBeenCalledTimes(2);
});
it('remembers ignored builds across navigation and reload but allows a newer build to notify', async () => {
  const mod = await import('./app-update-monitor');
  cleanups.push(mod.subscribeAppUpdates(vi.fn())); await settle();
  mod.ignoreAppUpdate(); expect(mod.getAppUpdateSnapshot().ignoredBuild).toBe(77);
  cleanups.splice(0).forEach(stop => stop());
  vi.resetModules(); const reloaded = await import('./app-update-monitor');
  h.check.mockResolvedValueOnce({ ...release, required: 80, latest: 80 });
  cleanups.push(reloaded.subscribeAppUpdates(vi.fn())); await settle();
  expect(reloaded.getAppUpdateSnapshot().ignoredBuild).toBe(77);
  expect(reloaded.getAppUpdateSnapshot().update?.required).toBe(80);
});
it('stops background work when the last subscriber leaves and never checks native updates on the web', async () => {
  const mod = await import('./app-update-monitor');
  const stop = mod.subscribeAppUpdates(vi.fn()); await settle(); stop();
  await vi.advanceTimersByTimeAsync(mod.APK_CHECK_INTERVAL_MS * 2);
  expect(h.check).toHaveBeenCalledOnce();
  h.native = false;
  cleanups.push(mod.subscribeAppUpdates(vi.fn()));
  await settle(); expect(h.check).toHaveBeenCalledOnce();
});
it('reads the installed version offline and refreshes release metadata when the connection returns', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const mod = await import('./app-update-monitor');
  h.check.mockResolvedValueOnce({ ...release, required: null, available: false });
  cleanups.push(mod.subscribeAppUpdates(vi.fn())); await settle();
  expect(mod.getAppUpdateSnapshot().checked).toBe(true);
  expect(mod.getAppUpdateSnapshot().update?.installed).toBe(76);
  online.mockReturnValue(true); window.dispatchEvent(new Event('online')); await settle();
  expect(h.check).toHaveBeenLastCalledWith(true);
  expect(mod.getAppUpdateSnapshot().update?.available).toBe(true); online.mockRestore();
});
