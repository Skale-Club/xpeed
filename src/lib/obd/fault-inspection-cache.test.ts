import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { faultInspectionScope, loadFaultInspection, saveFaultInspection, type SavedFaultInspection } from './fault-inspection-cache';

const saved: SavedFaultInspection = {
  profileVin: 'VIN', syncFailed: false,
  inspection: { at: '2026-10-30T12:00:00.123Z', vin: 'VIN', readout: { stored: ['P1999'], pending: ['P0300'], permanent: ['P0420'], checked: true, complete: false, modules: ['7E0'], codeModules: { P1999: ['7E0'] } } },
};
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it('keeps the exact readout, timestamp and incomplete status for the same owner and car', () => {
  expect(saveFaultInspection('user', 'car', saved)).toBe(true);
  expect(loadFaultInspection('user', 'car', 'VIN')).toEqual(saved);
  expect(loadFaultInspection('other-user', 'car', 'VIN')).toBeNull();
  expect(loadFaultInspection('user', 'other-car', 'VIN')).toBeNull();
  expect(loadFaultInspection(null, 'car', 'VIN')).toBeNull();
});
it('does not reuse a changed VIN, but accepts a VIN newly confirmed by the car', () => {
  saveFaultInspection('user', 'car', saved);
  expect(loadFaultInspection('user', 'car', 'OTHER')).toBeNull();
  expect(saveFaultInspection('user', 'car', { ...saved, profileVin: 'OTHER' })).toBe(false);
  saveFaultInspection('user', 'car', { ...saved, profileVin: null });
  expect(loadFaultInspection('user', 'car', 'VIN')).toMatchObject({ inspection: saved.inspection });
});
it('ignores corrupt or incomplete device copies without triggering any work', () => {
  const key = faultInspectionScope('user', 'car')!;
  for (const value of ['{', '{}', JSON.stringify({ ...saved, inspection: { ...saved.inspection, readout: { stored: null } } })]) {
    localStorage.setItem(key, value);
    expect(loadFaultInspection('user', 'car', 'VIN')).toBeNull();
  }
});
it('reports a failed device save and tolerates unavailable storage', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(saveFaultInspection('user', 'car', saved)).toBe(false);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(loadFaultInspection('user', 'car', 'VIN')).toBeNull();
});
