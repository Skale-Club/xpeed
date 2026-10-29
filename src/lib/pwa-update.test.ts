import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterSW } from '@/lib/pwa-update';

// The module keeps listeners and "update waiting" state at module level (it is
// started once per page load), so each test gets a fresh copy.
async function setup() {
  vi.resetModules();
  const mod = await import('@/lib/pwa-update');
  const updateSW = vi.fn().mockResolvedValue(undefined);
  const registration = { update: vi.fn().mockResolvedValue(undefined) };
  let options: Parameters<RegisterSW>[0] = {};
  const register: RegisterSW = (o) => {
    options = o;
    return updateSW;
  };
  mod.startPwaUpdates(register);
  options.onRegisteredSW?.('/sw.js', registration as unknown as ServiceWorkerRegistration);
  return { mod, updateSW, registration, options: () => options };
}

describe('startPwaUpdates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    window.__xpeedRecording = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks for a new version every 30 minutes', async () => {
    const { mod, registration } = await setup();
    vi.advanceTimersByTime(mod.UPDATE_CHECK_INTERVAL_MS);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it('applies a waiting update immediately when no trip is recording', async () => {
    const { mod, updateSW, options } = await setup();
    options().onNeedRefresh?.();
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(mod.hasPendingUpdate()).toBe(false);
  });

  it('holds the update while recording and applies it when the trip ends', async () => {
    const { mod, updateSW, options } = await setup();
    mod.setTripRecording(true);
    expect(mod.isTripRecording()).toBe(true);
    options().onNeedRefresh?.();
    expect(updateSW).not.toHaveBeenCalled();
    expect(mod.hasPendingUpdate()).toBe(true);
    mod.setTripRecording(false);
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('does not auto-apply twice within a minute (reload-loop guard)', async () => {
    const { updateSW, options } = await setup();
    options().onNeedRefresh?.();
    options().onNeedRefresh?.();
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('defers the worker reload if a trip starts while the worker is activating', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    const { mod, options } = await setup();
    options().onNeedRefresh?.();
    mod.setTripRecording(true);
    options().onNeedReload?.();
    expect(reload).not.toHaveBeenCalled();
    mod.setTripRecording(false);
    expect(reload).toHaveBeenCalledTimes(1);
    options().onNeedReload?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('manually checks for new screens and reloads once when no new worker is needed', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    const { mod, registration, options } = await setup();
    expect(await mod.reloadAppScreens()).toBe('reloading');
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    options().onNeedReload?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('manual reload applies a waiting worker despite the automatic reload cooldown', async () => {
    const { mod, updateSW, registration, options } = await setup();
    sessionStorage.setItem('xpeed:sw-applied-at', String(Date.now()));
    options().onNeedRefresh?.();
    expect(updateSW).not.toHaveBeenCalled();
    await mod.reloadAppScreens();
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('does not reload a recording or an unsaved draft, including one started during the network check', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    const { mod, registration } = await setup();
    mod.setTripRecording(true);
    expect(await mod.reloadAppScreens()).toBe('blocked');
    mod.setTripRecording(false);
    const release = mod.holdAppUpdates();
    expect(await mod.reloadAppScreens()).toBe('blocked');
    release();
    registration.update.mockImplementationOnce(async () => { mod.setTripRecording(true); });
    expect(await mod.reloadAppScreens()).toBe('blocked');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports a failed screen check without reloading cached screens', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    const { mod, registration } = await setup();
    registration.update.mockRejectedValueOnce(new Error('offline'));
    await expect(mod.reloadAppScreens()).rejects.toThrow('offline');
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits for the downloaded screens to finish installing before activating them', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    const { mod, registration, updateSW } = await setup();
    const worker = Object.assign(new EventTarget(), { state: 'installing' });
    Object.assign(registration, { installing: worker });
    const pending = mod.reloadAppScreens();
    await Promise.resolve();
    expect(updateSW).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    worker.state = 'installed';
    Object.assign(registration, { installing: null, waiting: worker });
    worker.dispatchEvent(new Event('statechange'));
    expect(await pending).toBe('reloading');
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(reload).not.toHaveBeenCalled(); // controllerchange will reload after activation
  });
});

describe('installPreloadErrorReload', () => {
  it('waits for recording and durable persistence before a chunk-error reload', async () => {
    vi.resetModules();
    const mod = await import('@/lib/pwa-update');
    sessionStorage.clear();
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    mod.installPreloadErrorReload();
    mod.setTripRecording(true);
    const release = mod.holdAppUpdates();
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).not.toHaveBeenCalled();
    mod.setTripRecording(false);
    expect(reload).not.toHaveBeenCalled();
    release();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('lets a repeated chunk failure surface instead of reloading forever', async () => {
    vi.resetModules();
    const mod = await import('@/lib/pwa-update');
    sessionStorage.clear();
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    mod.installPreloadErrorReload();
    const fire = () => {
      const e = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fire()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
