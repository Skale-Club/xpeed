import { describe, expect, it } from 'vitest';
import { analyseTrip, tripColumns } from './trip-analysis';

const SPEED = 'Vehicle speed (km/h)';
const RPM = 'Engine RPM (rpm)';
const COOLANT = 'Engine coolant temperature (°C)';
const mapping = {
  [SPEED]: { canonical_key: 'vehicle_speed' },
  [RPM]: { canonical_key: 'engine_rpm' },
  [COOLANT]: { canonical_key: 'coolant_temp' },
};
const row = (t: number, data: Record<string, number>) => ({ t_seconds: t, data });

describe('tripColumns', () => {
  it('uses the stored mapping and falls back to the column name', () => {
    const cols = tripColumns([row(0, { [SPEED]: 1, 'Hybrid battery remaining life (%)': 60 })], { [SPEED]: { canonical_key: 'vehicle_speed' } });
    expect(cols).toEqual({ speed: SPEED, soc: 'Hybrid battery remaining life (%)' });
  });
});

describe('analyseTrip', () => {
  it('splits the time into speed bands and counts stops', () => {
    // 0-10 s standing, 10-40 s town (30 km/h), 40-70 s road (70), 70-100 s motorway (110), 100-120 s standing.
    const speeds = [0, 0, 30, 30, 30, 30, 70, 70, 70, 70, 110, 110, 110, 110, 0, 0];
    const times = [0, 10, 11, 20, 30, 40, 41, 50, 60, 70, 71, 80, 90, 100, 101, 120];
    const a = analyseTrip(times.map((t, i) => row(t, { [SPEED]: speeds[i] })), mapping);
    expect(a.topSpeed).toBe(110);
    expect(a.stops).toBe(1);
    expect(a.mix!.motorway).toBe(30); // 70 → 71 s averages 90 km/h, already motorway
    expect(a.mix!.stopped).toBeGreaterThan(25);
    expect(a.recordedSeconds).toBe(120);
  });

  it('never bridges a gap in the recording', () => {
    const a = analyseTrip([row(0, { [SPEED]: 50 }), row(10, { [SPEED]: 50 }), row(20, { [SPEED]: 50 }), row(500, { [SPEED]: 50 })], mapping);
    expect(a.recordedSeconds).toBe(20);
  });

  it('follows the spacing of a thinned long trip', () => {
    const a = analyseTrip([0, 40, 80, 120, 1000].map((t) => row(t, { [SPEED]: 50 })), mapping);
    expect(a.recordedSeconds).toBe(120); // 40 s is this trip's normal spacing; 880 s is still a gap
  });

  it('counts sudden braking and hard acceleration', () => {
    const a = analyseTrip([row(0, { [SPEED]: 0 }), row(1, { [SPEED]: 12 }), row(2, { [SPEED]: 60 }), row(3, { [SPEED]: 40 }), row(4, { [SPEED]: 41 })], mapping);
    // 0 → 12 and 12 → 60 km/h in 1 s each (3.3 and 13 m/s²); 60 → 40 is -5.6 m/s²; 40 → 41 is gentle.
    expect(a.hardAccels).toBe(2);
    expect(a.hardBrakes).toBe(1);
  });

  it('times the engine warm-up', () => {
    const a = analyseTrip([0, 60, 120, 180, 240].map((t, i) => row(t, { [COOLANT]: 30 + i * 12 })), mapping);
    expect(a.warmup).toEqual({ startC: 30, maxC: 78, startedWarm: false, warmAfterSeconds: 240 });
  });

  it('measures electric-only driving for hybrids only', () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(i * 5, { [SPEED]: 30, [RPM]: i < 6 ? 0 : 1400 }));
    expect(analyseTrip(rows, mapping, { hybrid: true }).electricShare).toBeCloseTo(5 / 12); // the stretch where the engine starts counts as neither
    expect(analyseTrip(rows, mapping).electricShare).toBeNull();
  });

  it('counts idling as standing with the engine running', () => {
    const a = analyseTrip([row(0, { [SPEED]: 0, [RPM]: 800 }), row(20, { [SPEED]: 0, [RPM]: 800 }), row(40, { [SPEED]: 0, [RPM]: 0 })], mapping);
    expect(a.idleSeconds).toBe(20);
  });
});
