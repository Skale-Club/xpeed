import { describe, it, expect } from 'vitest';
import { TripDetector, DEFAULT_TRIP_OPTIONS, type TripReading } from './trip-detector';
import { reconnectDelay, standbyProbeDelay, standbyVoltageDelay } from '@/hooks/use-obd-scanner';

const S = 1000;
const on = (at: number, speedKmh = 0, rpm = 0): TripReading => ({ at, ecuAlive: true, speedKmh, rpm });
const off = (at: number): TripReading => ({ at, ecuAlive: false, speedKmh: null, rpm: null });

describe('TripDetector', () => {
  it('keeps one recording from idling into a 16 mph drive with rising RPM', () => {
    const detector = new TripDetector();
    expect(detector.update(on(0, 0, 900))).toEqual([]);
    for (let seconds = 1; seconds <= 60; seconds++) {
      expect(detector.update(on(seconds * S, 0, 900))).toEqual([]);
      expect(detector.recording).toBe(false);
    }
    for (let seconds = 61; seconds <= 180; seconds++) {
      expect(detector.update(on(seconds * S, 16 * 1.609344, 1400 + seconds)))
        .toEqual(seconds === 61 ? [{ type: 'start', at: 61 * S }] : []);
      expect(detector.recording).toBe(true);
    }
  });
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

  it('does not restart right after the user ends a trip while driving', () => {
    const d = new TripDetector();
    for (let t = 0; t < 120; t += 5) d.update(on(t * S, 40));
    expect(d.stop(120 * S, 'manual')).toEqual([{ type: 'end', at: 120 * S, reason: 'manual', keep: true }]);
    for (let t = 121; t < 200; t += 5) expect(d.update(on(t * S, 40))).toEqual([]);
    // Switched off and on again: the next drive is recorded as usual
    d.update(off(230 * S));
    expect(d.update(on(300 * S, 30))).toEqual([{ type: 'start', at: 300 * S }]);
  });

  it('records again after the car was parked following a manual stop', () => {
    const d = new TripDetector();
    for (let t = 0; t < 60; t += 5) d.update(on(t * S, 40));
    d.stop(60 * S, 'manual');
    // Sitting still with the car on, answering every 5 s
    const parkedUntil = 60 * S + DEFAULT_TRIP_OPTIONS.parkedAfterMs;
    for (let t = 60 * S; t <= parkedUntil; t += 5 * S) expect(d.update(on(t, 0))).toEqual([]);
    expect(d.update(on(parkedUntil + 5 * S, 20))).toHaveLength(1);
  });

  it('only starts automatically when allowed', () => {
    const d = new TripDetector();
    expect(d.update(on(0, 50, 2000), false)).toEqual([]);
    expect(d.recording).toBe(false);
  });
});

describe('waiting for the car without draining the battery', () => {
  it('checks a parked car less often after a while', () => {
    expect(standbyProbeDelay(0)).toBe(4000);
    expect(standbyProbeDelay(5 * 60 * S)).toBe(10_000);
    expect(standbyProbeDelay(15 * 60 * S)).toBe(30_000);
    expect(standbyProbeDelay(3 * 60 * 60 * S)).toBe(60_000);
  });

  it('reads the adapter voltage often, since that never touches the car', () => {
    expect(standbyVoltageDelay(0)).toBe(4000);
    expect(standbyVoltageDelay(30 * 60 * S)).toBe(10_000);
  });

  it('backs off retrying an adapter that stays out of reach', () => {
    expect(reconnectDelay(0)).toBe(5000);
    expect(reconnectDelay(20 * 60 * S)).toBe(30_000);
    expect(reconnectDelay(3 * 60 * 60 * S)).toBe(120_000);
  });
});

describe('a Bluetooth stall is not the car turning off', () => {
  const stalled = (at: number): TripReading => ({ at, ecuAlive: false, speedKmh: null, rpm: null, linkDown: true });

  it('keeps the trip open through a stall much longer than the car-off time, and carries on after it', () => {
    const d = new TripDetector();
    d.update(on(0, 50, 2000));
    for (let t = 5; t <= 100; t += 5) d.update(on(t * S, 50, 2000));
    // 90 s of the adapter not answering: far past the 20 s of silence that mean "car off"
    for (let t = 105; t <= 190; t += 5) expect(d.update(stalled(t * S))).toEqual([]);
    // The link comes back and the car is still answering: still the same trip
    expect(d.update(on(195 * S, 50, 2000))).toEqual([]);
    expect(d.recording).toBe(true);
    // ...and a real silence afterwards still ends it, 20 s after the last answer
    expect(d.update(off(205 * S))).toEqual([]);
    expect(d.update(off(216 * S))).toEqual([{ type: 'end', at: 195 * S, reason: 'car-off', keep: true }]);
  });

  it('does not count a stall as silence when the car then really answers NO DATA', () => {
    const d = new TripDetector();
    d.update(on(0, 50, 2000));
    for (let t = 5; t <= 60; t += 5) d.update(on(t * S, 50, 2000));
    for (let t = 65; t <= 100; t += 5) d.update(stalled(t * S));
    // The adapter is back but the car says nothing: only the silence since then counts, not the stall
    expect(d.update(off(105 * S))).toEqual([]);
    expect(d.update(off(110 * S))).toEqual([]);
  });

  it('ends the trip after a long grace when the adapter never comes back, at the last time the car answered', () => {
    const d = new TripDetector();
    d.update(on(0, 50, 2000));
    d.update(on(60 * S, 50, 2000));
    let events: ReturnType<TripDetector['update']> = [];
    let t = 65;
    for (; t < 600 && events.length === 0; t += 5) events = d.update(stalled(t * S));
    expect(events).toEqual([{ type: 'end', at: 60 * S, reason: 'disconnected', keep: true }]);
    expect((t - 5) * S - 60 * S).toBeGreaterThanOrEqual(DEFAULT_TRIP_OPTIONS.linkGraceMs);
  });
});

describe('warm-up in a parking spot is not a trip', () => {
  it('does not start an automatic trip that never moved', () => {
    const d = new TripDetector();
    // A cold hybrid in READY idling at speed 0 for two minutes, engine cycling
    expect(d.update(on(0, 0, 1200))).toEqual([]);
    for (let t = 5; t <= 120; t += 5) d.update(on(t * S, 0, 1200));
    expect(d.update(off(130 * S))).toEqual([]);
    expect(d.update(off(141 * S))).toEqual([]);
  });

  it('keeps a trip that moved at some point, and one the user started by hand', () => {
    const d = new TripDetector();
    d.update(on(0, 0, 1200));
    for (let t = 5; t <= 100; t += 5) d.update(on(t * S, t === 5 ? 12 : 0, 1200));
    d.update(off(110 * S));
    expect(d.update(off(125 * S))[0]).toMatchObject({ keep: true });

    d.startManual(1000 * S);
    d.update(on(1010 * S, 0, 0));
    expect(d.stop(1100 * S, 'manual')[0]).toMatchObject({ keep: true });
  });

  it('cannot judge a car that reports no speed, so keeps its trips', () => {
    const d = new TripDetector();
    const noSpeed = (at: number): TripReading => ({ at, ecuAlive: true, speedKmh: null, rpm: 1500 });
    d.update(noSpeed(0));
    d.update(noSpeed(100 * S));
    d.update(off(110 * S));
    expect(d.update(off(125 * S))[0]).toMatchObject({ keep: true });
  });
});
