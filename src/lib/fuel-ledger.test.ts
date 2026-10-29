import { describe, it, expect } from 'vitest';
import { aggregateFuel, compareFuel, fuelPriceAt, tankIntervals, tripFuelEstimate, validateFuelEntry, type FuelEntry } from './fuel-ledger';
import type { Session } from '@/types/session';
const fill = (at: string, odometerKm: number, litres: number, fullTank = true): FuelEntry => ({ id: at, kind: 'fill', at, odometerKm, litres, fullTank, pricePerLitre: 1, totalPaid: litres, currency: 'USD', source: 'receipt', region: '', sourceUrl: '', note: '' });
const trip = (at: string, litres = 1, km = 20): Session => ({ id: at, session_start: at, uploaded_at: at, duration_seconds: 1800, summary: { fuel: { version: 1, source: 'obd_flow', litres, fuelSeconds: 1800, distanceKm: km, distanceSeconds: 1800, duration: 1800, coverage: 1, distanceCoverage: 1 } } } as unknown as Session);
describe('fuel ledger', () => {
  it('never uses a future price to reprice an old trip', () => {
    const entries = [fill('2026-01-10T12:00:00Z', 100, 10)];
    expect(fuelPriceAt(entries, '2026-01-01T00:00:00Z')).toBeNull();
    expect(tripFuelEstimate(trip('2026-01-01T00:00:00Z'), entries).cost).toBeNull();
  });
  it('includes partial fills between full tanks and never applies a future tank average', () => {
    const entries = [fill('2026-01-01T12:00:00Z', 100, 20), fill('2026-01-03T12:00:00Z', 150, 5, false), fill('2026-01-10T12:00:00Z', 200, 5)];
    expect(tankIntervals(entries)[0]).toMatchObject({ km: 100, litres: 10, kmPerLitre: 10 });
    const old = trip('2026-01-05T00:00:00Z'); old.summary = { summaries: [{ canonical_key: 'vehicle_speed', avg: 40 }] };
    expect(tripFuelEstimate(old, entries).litres).toBeNull();
  });
  it('keeps actual spending separate from trip estimates and currencies separate', () => {
    const usd = fill('2026-01-01T12:00:00Z', 100, 10); usd.totalPaid = 30; usd.pricePerLitre = 3;
    const brl = { ...fill('2026-01-03T12:00:00Z', 200, 10), currency: 'BRL' as const, totalPaid: 60, pricePerLitre: 6 };
    const period = aggregateFuel([trip('2026-01-02T12:00:00Z')], [usd,brl], 'month', 'UTC')[0];
    expect(period.paid).toEqual({ USD: 30, BRL: 60 }); expect(period.tripCost).toEqual({ USD: 3 });
  });
  it('requires sufficient comparable covered trips before reporting a trend', () => {
    const recent = ['2026-10-15','2026-10-16','2026-10-17'].map(at => trip(`${at}T12:00:00Z`, 1.2));
    const earlier = ['2026-09-10','2026-09-11','2026-09-12'].map(at => trip(`${at}T12:00:00Z`));
    expect(compareFuel([...recent, ...earlier], new Date('2026-10-29'))?.deltaPct).toBeCloseTo(20);
    expect(compareFuel([...recent, ...earlier.slice(0,2)], new Date('2026-10-29'))).toBeNull();
    earlier[0].summary!.fuel = { ...(earlier[0].summary!.fuel as object), coverage: .1 };
    expect(compareFuel([...recent,...earlier], new Date('2026-10-29'))).toBeNull();
  });
  it('rejects invalid amounts and reference prices pretending to be receipts', () => {
    expect(validateFuelEntry(fill('2026-01-01T12:00:00Z', 100, 10))).toBe(true);
    expect(validateFuelEntry({ ...fill('2026-01-01T12:00:00Z',100,10), litres: -1 })).toBe(false);
    expect(validateFuelEntry({ ...fill('2026-01-01T12:00:00Z',100,10), kind: 'reference', totalPaid: null })).toBe(false);
  });
});
