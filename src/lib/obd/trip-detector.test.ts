import { describe, it, expect } from 'vitest';
import { TripDetector, DEFAULT_TRIP_OPTIONS, type TripReading } from './trip-detector';
import { normalizeVehicleIssue } from '@/lib/db-extras';

const S = 1000;
const on = (at: number, speedKmh = 0, rpm = 0): TripReading => ({ at, ecuAlive: true, speedKmh, rpm });
const off = (at: number): TripReading => ({ at, ecuAlive: false, speedKmh: null, rpm: null });

describe('TripDetector', () => {
  it('does not record a hybrid sitting in READY or a car that is off', () => {
    const d = new TripDetector();
    expect(d.update(on(0))).toEqual([]);
    expect(d.update(off(5 * S))).toEqual([]);
    expect(d.recording).toBe(false);
  });

  it('starts when the car moves or the engine runs, and ends when the car turns off', () => {
    const d = new TripDetector();
    expect(d.update(on(0, 30, 1500))).toEqual([{ type: 'start', at: 0 }]);
    d.update(on(90 * S, 0, 0));
    d.update(off(100 * S));
    expect(d.carOn(100 * S)).toBe(true);
    // 20 s of silence after the last answer = switched off; the trip ends at the last answer
    expect(d.update(off(110 * S))).toEqual([{ type: 'end', at: 90 * S, reason: 'car-off', keep: true }]);
    expect(d.carOn(110 * S)).toBe(false);
  });

  it('ends a parked trip at the moment it stopped moving', () => {
    const d = new TripDetector();
    d.update(on(0, 40));
    d.update(on(100 * S, 40));
    d.update(on(101 * S, 0));
    const events = d.update(on(100 * S + DEFAULT_TRIP_OPTIONS.parkedAfterMs));
    expect(events).toEqual([{ type: 'end', at: 100 * S, reason: 'parked', keep: true }]);
  });

  it('drops very short automatic trips', () => {
    const d = new TripDetector();
    d.update(on(0, 10));
    d.update(on(30 * S, 10));
    expect(d.update(off(60 * S))).toEqual([{ type: 'end', at: 30 * S, reason: 'car-off', keep: false }]);
  });

  it('keeps a trip the user ends by hand unless it was a mis-tap', () => {
    const d = new TripDetector();
    expect(d.startManual(0)).toEqual([{ type: 'start', at: 0 }]);
    expect(d.stop(3 * S, 'manual')).toEqual([{ type: 'end', at: 3 * S, reason: 'manual', keep: false }]);
    d.startManual(10 * S);
    expect(d.stop(20 * S, 'manual')[0]).toMatchObject({ keep: true });
    // An automatic trip ended by hand after 30 s is kept too
    d.update(on(100 * S, 30));
    expect(d.stop(130 * S, 'manual')[0]).toMatchObject({ reason: 'manual', keep: true });
  });

  it('does not let a parked car end a manual trip', () => {
    const d = new TripDetector();
    d.startManual(0);
    expect(d.update(on(DEFAULT_TRIP_OPTIONS.parkedAfterMs * 2))).toEqual([]);
    expect(d.recording).toBe(true);
  });

  it('only starts automatically when allowed', () => {
    const d = new TripDetector();
    expect(d.update(on(0, 50, 2000), false)).toEqual([]);
    expect(d.recording).toBe(false);
  });
});

describe('normalizeVehicleIssue', () => {
  it('maps the reconciler vocabulary onto the Problems page', () => {
    const issue = normalizeVehicleIssue({ id: '1', status: 'active', severity: 'serious', resolved_note: 'fixed' });
    expect(issue).toMatchObject({ status: 'open', severity: 'critical', resolution_note: 'fixed', dtc_code: null });
    expect(normalizeVehicleIssue({ status: 'ignored', severity: 'easy_fix' })).toMatchObject({ status: 'dismissed', severity: 'info' });
    expect(normalizeVehicleIssue({ status: 'weird', severity: 'weird' })).toMatchObject({ status: 'open', severity: 'attention' });
  });
});
