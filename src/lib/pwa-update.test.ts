import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterSW } from '@/lib/pwa-update';
import { UPDATE_IDLE_MS } from '@/lib/idle-update';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); document.body.replaceChildren(); });

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
  cleanups.push(mod.startPwaUpdates(register));
  options.onRegisteredSW?.('/sw.js', registration as unknown as ServiceWorkerRegistration);
  vi.advanceTimersByTime(UPDATE_IDLE_MS);
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

  it('waits for a fresh idle window after touch, typing and scrolling', async () => {
    const { updateSW, options } = await setup();
    window.dispatchEvent(new Event('pointerdown'));
    options().onNeedRefresh?.();
    vi.advanceTimersByTime(20_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(20_000);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(UPDATE_IDLE_MS - 1);
    expect(updateSW).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(updateSW).toHaveBeenCalledOnce();
  });
  it('does not update an editor or open dialog after idle time expires', async () => {
    const { updateSW, options } = await setup();
    const input = document.createElement('input'); document.body.append(input); input.focus();
    options().onNeedRefresh?.(); vi.advanceTimersByTime(UPDATE_IDLE_MS * 2);
    expect(updateSW).not.toHaveBeenCalled();
    input.blur(); input.remove();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
    vi.advanceTimersByTime(UPDATE_IDLE_MS);
    expect(updateSW).not.toHaveBeenCalled();
    dialog.remove(); window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(UPDATE_IDLE_MS);
    expect(updateSW).toHaveBeenCalledOnce();
  });
  it('holds an update during continuous mouse or touch movement', async () => {
    const { updateSW, options } = await setup();
    window.dispatchEvent(new Event('pointerdown')); options().onNeedRefresh?.();
    for (const event of ['pointermove', 'touchmove', 'pointermove']) {
      vi.advanceTimersByTime(10_000); window.dispatchEvent(new Event(event));
    }
    expect(updateSW).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UPDATE_IDLE_MS);
    expect(updateSW).toHaveBeenCalledOnce();
  });
  it('waits again if the user interacts while the new version activates, keeping the URL', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { pathname: '/history', search: '?month=2026-10', hash: '#today', reload } });
    const { updateSW, options } = await setup();
    options().onNeedRefresh?.(); expect(updateSW).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('pointerdown')); options().onNeedReload?.();
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UPDATE_IDLE_MS);
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem('xpeed:update-position')!).page).toBe('/history?month=2026-10#today');
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
