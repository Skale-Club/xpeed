import { describe, expect, it } from 'vitest';
import { EMPTY_VEHICLE_CARE, KM_PER_MILE, oilReminder, oilPlanCompleted, validCare, type VehicleCareRecord } from './vehicle-care';
import { loadVehicleNotifications, mergeVehicleNotification, oilNotification, saveVehicleNotifications } from './vehicle-notifications';

const record = (changes = {}): VehicleCareRecord => ({ state: { ...EMPTY_VEHICLE_CARE, odometerKm: 149500 * KM_PER_MILE, oilDueKm: 150000 * KM_PER_MILE, warnBeforeKm: 500 * KM_PER_MILE, oilPlanAt: '2026-10-29T12:00:00Z', ...changes }, revision: 'r1', lastOil: null });
describe('oil maintenance reminders', () => {
  it('uses the entered mileage, including the exact miles-to-km threshold, and transitions from soon to due', () => {
    expect(oilReminder(record(), '2026-10-29')?.status).toBe('soon');
    expect(oilReminder(record({ odometerKm: 149499 * KM_PER_MILE }), '2026-10-29')).toBeNull();
    expect(oilReminder(record({ odometerKm: 150000 * KM_PER_MILE }), '2026-10-29')?.status).toBe('due');
    expect(oilReminder(record({ odometerKm: null }), '2026-10-29')).toBeNull();
  });
  it('notifies by the calendar date even without mileage and supports disabling reminders', () => {
    expect(oilReminder(record({ odometerKm: null, oilDueKm: null, oilDueDate: '2026-11-01', warnBeforeDays: 3 }), '2026-10-29')?.status).toBe('soon');
    expect(oilReminder(record({ odometerKm: null, oilDueDate: '2026-10-29' }), '2026-10-29')?.status).toBe('due');
    expect(oilReminder(record({ enabled: false, oilDueDate: '2026-10-29' }), '2026-10-29')).toBeNull();
  });
  it('clears the previous plan after a new oil change, using the owner’s calendar day', () => {
    const value = record({ oilPlanAt: '2026-10-30T01:00:00Z' });
    value.lastOil = { id: 'oil', performed_at: '2026-10-29', odometer_km: 150000 * KM_PER_MILE, created_at: '2026-10-30T01:10:00+00:00' };
    expect(oilPlanCompleted(value, 'America/New_York')).toBe(true);
    expect(oilReminder(value, '2026-10-29', 'America/New_York')).toBeNull();
    // Entering an older service does not claim that the current change is done.
    value.lastOil.performed_at = '2026-10-01';
    expect(oilPlanCompleted(value, 'America/New_York')).toBe(false);
  });
  it('rejects invalid dates, negative mileage and excessive alert lead times', () => {
    expect(validCare(record().state)).toBe(true);
    expect(validCare(record({ oilDueDate: '2026-02-30' }).state)).toBe(false);
    expect(validCare(record({ odometerKm: -1 }).state)).toBe(false);
    expect(validCare(record({ warnBeforeDays: 366 }).state)).toBe(false);
    expect(validCare(record({ oilDueKm: Infinity }).state)).toBe(false);
  });
  it('keeps an acknowledged warning read while mileage changes, and reopens it when due', () => {
    const soon = oilReminder(record(), '2026-10-29')!;
    const previous = { ...oilNotification(soon, 'plan'), read: true };
    const repeated = mergeVehicleNotification([previous], oilNotification({ ...soon, odometerKm: 149600 * KM_PER_MILE }, 'plan'));
    expect(repeated[0].read).toBe(true);
    const due = mergeVehicleNotification(repeated, oilNotification({ ...soon, status: 'due' }, 'plan'));
    expect(due[0].read).toBe(false);
    saveVehicleNotifications('care-test', due);
    expect(loadVehicleNotifications('care-test')[0].kind).toBe('maintenance');
    expect(loadVehicleNotifications('different-car')).toEqual([]);
    localStorage.removeItem('care-test');
  });
});
