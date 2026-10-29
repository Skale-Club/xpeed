import type { ParsedCSV } from './csv-parser';
import { sessionDuration, sessionTimes } from './session-time';

export interface FuelMetrics {
  version: 1;
  source: 'obd_flow';
  litres: number | null;
  fuelSeconds: number;
  distanceKm: number | null;
  distanceSeconds: number;
  duration: number | null;
  coverage: number;
  distanceCoverage: number;
}
/** Full-resolution integration before row downsampling. A missing reading stays a gap. */
export function calculateFuelMetrics(parsed: ParsedCSV): FuelMetrics {
  const times = sessionTimes(parsed);
  const duration = sessionDuration(parsed) ?? null;
  const fuelKey = Object.entries(parsed.headerMapping).find(([, value]) => value?.canonical_key === 'mpg_or_fuel_rate' && value.unit === 'L/h')?.[0];
  const speedKey = Object.entries(parsed.headerMapping).find(([, value]) => value?.canonical_key === 'vehicle_speed' && value.unit === 'km/h')?.[0];
  const integrate = (key: string | undefined) => {
    let total = 0, covered = 0;
    let previous: { time: number; value: number } | null = null;
    if (!key || !parsed.timeColumn || parsed.timeColumn.type === 'index') return { total: null, covered };
    parsed.rows.forEach((row, index) => {
      // Long exports interleave sensors. An absent field is another sensor's
      // observation; an explicit missing/invalid field breaks this sensor's series.
      if (!Object.prototype.hasOwnProperty.call(row, key)) return;
      const value = row[key], time = times[index];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || time == null) { previous = null; return; }
      if (previous) {
        const gap = time - previous.time;
        if (gap > 0 && gap <= 30) { total += (value + previous.value) / 2 * gap / 3600; covered += gap; }
      }
      previous = { time, value };
    });
    return { total: covered ? total : null, covered };
  };
  const f = integrate(fuelKey), d = integrate(speedKey);
  const fuel = f.total, distance = d.total, fuelSeconds = f.covered, distanceSeconds = d.covered;
  return { version: 1, source: 'obd_flow', litres: fuelSeconds ? fuel : null, fuelSeconds, distanceKm: distanceSeconds ? distance : null, distanceSeconds, duration, coverage: duration && duration > 0 ? Math.min(1, fuelSeconds / duration) : 0, distanceCoverage: duration && duration > 0 ? Math.min(1, distanceSeconds / duration) : 0 };
}
