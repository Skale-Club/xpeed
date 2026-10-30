import { beforeEach, describe, expect, it } from 'vitest';
import { loadVehicleNotifications, mergeVehicleNotification, notificationScope, saveVehicleNotifications, scanNotification, problemNotification } from './vehicle-notifications';
import type { VehicleIssue } from './db-issues';
import type { FaultCodeReadout } from './obd/fault-codes';

const scan = (over: Partial<FaultCodeReadout> = {}): FaultCodeReadout => ({ stored: [], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'], ...over });
beforeEach(() => localStorage.clear());
describe('vehicle notices', () => {
  it('consolidates repeated problems without new unread alerts, but alerts on increased severity', () => {
    const issue={id:'i1',canonical_key:'coolant_temp',status:'active',severity:'warning',recurrence_count:1,last_seen_at:'2026-10-30T10:00:00Z'} as VehicleIssue;
    const first={...problemNotification(issue),read:true};
    // The old format included a recurrence counter in the fingerprint.
    first.fingerprint='active:warning:1';
    const repeated=mergeVehicleNotification([first],problemNotification({...issue,recurrence_count:5,last_seen_at:'2026-10-30T12:00:00Z'}));
    expect(repeated).toHaveLength(1);
    expect(repeated[0].read).toBe(true);
    expect(repeated[0].problem?.recurrence_count).toBe(5);
    const escalated=mergeVehicleNotification(repeated,problemNotification({...issue,severity:'critical',recurrence_count:6}));
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({read:false,severity:'critical'});
  });
  it('preserves read status across repeat checks and reloads, but flags changed codes', () => {
    const first = { ...scanNotification(scan(), '2026-10-29T10:00:00Z'), read: true };
    const repeated = mergeVehicleNotification([first], scanNotification(scan(), '2026-10-29T11:00:00Z'));
    expect(repeated[0]).toMatchObject({ read: true, at: first.at });
    const scope = notificationScope('user', 'car');
    saveVehicleNotifications(scope, repeated);
    expect(loadVehicleNotifications(scope)).toEqual(repeated);
    const changed = mergeVehicleNotification(repeated, scanNotification(scan({ pending: ['P0300'] }), '2026-10-29T12:00:00Z'));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ read: false, severity: 'warning' });
  });
  it('never labels silent or partial reads as success', () => {
    expect(scanNotification(scan({ complete: false }), '').severity).toBe('warning');
    expect(scanNotification(scan({ checked: false, complete: false, modules: [] }), '').severity).toBe('warning');
    expect(scanNotification(scan(), '').severity).toBe('success');
  });
  it('isolates accounts and cars and tolerates corrupted storage', () => {
    const scope = notificationScope('u1', 'c1');
    saveVehicleNotifications(scope, [scanNotification(scan(), '2026-10-29')]);
    expect(loadVehicleNotifications(notificationScope('u2', 'c1'))).toEqual([]);
    expect(loadVehicleNotifications(notificationScope('u1', 'c2'))).toEqual([]);
    localStorage.setItem(scope, 'broken');
    expect(loadVehicleNotifications(scope)).toEqual([]);
  });
});
