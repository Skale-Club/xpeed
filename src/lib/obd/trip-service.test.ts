import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native: true, start: vi.fn(), update: vi.fn(), stop: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => mocks }));
vi.mock('./native-ble', () => ({ isNativeApp: () => mocks.native }));
import { showBackgroundService, hideBackgroundService } from './trip-service';
describe('trip notification bridge', () => {
  beforeEach(async () => { mocks.native = true; await hideBackgroundService(); vi.clearAllMocks(); });
  it('sends live metrics and updates the same ongoing service', async () => {
    const trip = { vehicle: 'Prius', status: 'Recording', speed: '16', speedUnit: 'mph', distance: '2.4', distanceUnit: 'mi', startedAt: 123, active: true };
    await showBackgroundService('Xpeed', 'Recording', true, trip);
    expect(mocks.start).toHaveBeenCalledWith({ title: 'Xpeed', text: 'Recording', awake: true, trip });
    await showBackgroundService('Xpeed', 'Waiting', false);
    expect(mocks.update).toHaveBeenCalledWith({ title: 'Xpeed', text: 'Waiting', awake: false, trip: undefined });
    await hideBackgroundService();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('does not call native plugins on the web', async () => {
    mocks.native = false;
    await showBackgroundService('Xpeed', 'Recording');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('retries starting after a rejected native start', async () => {
    mocks.start.mockRejectedValueOnce(new Error('permission'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await showBackgroundService('Xpeed', 'Recording');
    await showBackgroundService('Xpeed', 'Recording');
    expect(mocks.start).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
