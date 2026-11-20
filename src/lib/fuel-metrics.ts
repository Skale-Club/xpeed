import type { ParsedCSV } from './csv-parser';
import { sessionDuration, sessionTimes } from './session-time';

/**
 * Petrol engines burn fuel at a fixed ratio to the air they take in (closed loop, about 14.7 g of air per
 * gram of fuel), so the air-flow sensor gives the fuel flow when the car doesn't report it: litres per hour =
 * g/s of air x 3600 / (14.7 x 745 g per litre). Valid for petrol and petrol hybrids only: diesels run lean,
 * and flex-fuel cars may be burning ethanol, whose ratio is very different.
 */
export const AIR_FUEL_RATIO = 14.7;
export const PETROL_GRAMS_PER_LITRE = 745;
export const airFlowToLitresPerHour = (gramsPerSecond: number) => gramsPerSecond * 3600 / (AIR_FUEL_RATIO * PETROL_GRAMS_PER_LITRE);
/** Engines whose fuel the air flow gives (see above). */
export const airFlowFuelApplies = (engineType: string | null | undefined) => engineType === 'petrol' || engineType === 'hybrid';

export interface FuelMetrics {
  version: 1;
  source: 'obd_flow';
  /** Where the litres come from; absent on trips worked out before air flow was used. */
  method?: 'fuel_rate' | 'air_flow' | null;
  litres: number | null;
  fuelSeconds: number;
  distanceKm: number | null;
  distanceSeconds: number;
  duration: number | null;
  coverage: number;
  distanceCoverage: number;
}
/** Full-resolution integration before row downsampling. A missing reading stays a gap. */
export function calculateFuelMetrics(parsed: ParsedCSV, engineType?: string | null): FuelMetrics {
  const times = sessionTimes(parsed);
  const duration = sessionDuration(parsed) ?? null;
  const fuelKey = Object.entries(parsed.headerMapping).find(([, value]) => value?.canonical_key === 'mpg_or_fuel_rate' && value.unit === 'L/h')?.[0];
  const speedKey = Object.entries(parsed.headerMapping).find(([, value]) => value?.canonical_key === 'vehicle_speed' && value.unit === 'km/h')?.[0];
  const airKey = !fuelKey && airFlowFuelApplies(engineType) ? Object.entries(parsed.headerMapping).find(([, value]) => value?.canonical_key === 'maf' && value.unit === 'g/s')?.[0] : undefined;
  const integrate = (key: string | undefined, convert: (value: number) => number = (value) => value) => {
    let total = 0, covered = 0;
    let previous: { time: number; value: number } | null = null;
    if (!key || !parsed.timeColumn || parsed.timeColumn.type === 'index') return { total: null, covered };
    parsed.rows.forEach((row, index) => {
      // Long exports interleave sensors. An absent field is another sensor's
      // observation; an explicit missing/invalid field breaks this sensor's series.
      if (!Object.prototype.hasOwnProperty.call(row, key)) return;
      const raw = row[key], time = times[index];
      const value = typeof raw === 'number' ? convert(raw) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || time == null) { previous = null; return; }
      if (previous) {
        const gap = time - previous.time;
        if (gap > 0 && gap <= 30) { total += (value + previous.value) / 2 * gap / 3600; covered += gap; }
      }
      previous = { time, value };
    });
    return { total: covered ? total : null, covered };
  };
  const f = fuelKey ? integrate(fuelKey) : integrate(airKey, airFlowToLitresPerHour), d = integrate(speedKey);
  const method = fuelKey ? 'fuel_rate' as const : airKey ? 'air_flow' as const : null;
  const fuel = f.total, distance = d.total, fuelSeconds = f.covered, distanceSeconds = d.covered;
  return { version: 1, source: 'obd_flow', method, litres: fuelSeconds ? fuel : null, fuelSeconds, distanceKm: distanceSeconds ? distance : null, distanceSeconds, duration, coverage: duration && duration > 0 ? Math.min(1, fuelSeconds / duration) : 0, distanceCoverage: duration && duration > 0 ? Math.min(1, distanceSeconds / duration) : 0 };
}
