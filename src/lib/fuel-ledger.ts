import type { FuelMetrics } from './fuel-metrics';
import type { Session } from '@/types/session';
import { tripDayKey } from './trip-history';

export { US_GALLON } from './fuel-units';
export interface FuelEntry {
  id: string;
  kind: 'fill' | 'reference';
  at: string;
  litres: number;
  pricePerLitre: number;
  totalPaid: number | null;
  currency: 'USD' | 'BRL' | 'EUR';
  odometerKm: number | null;
  fullTank: boolean;
  source: 'receipt' | 'manual' | 'regional';
  region: string;
  sourceUrl: string;
  note: string;
}
export function validateFuelEntry(value: unknown): value is Omit<FuelEntry, 'id'> {
  const item = value as FuelEntry;
  return !!item && ['fill', 'reference'].includes(item.kind) && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at))
    && Date.parse(item.at) <= Date.now() + 60_000
    && Number.isFinite(item.pricePerLitre) && item.pricePerLitre > 0 && item.pricePerLitre < 1000
    && ['USD', 'BRL', 'EUR'].includes(item.currency)
    && (item.kind === 'fill' ? Number.isFinite(item.totalPaid) && item.totalPaid! > 0 && item.totalPaid! < 1_000_000 : item.totalPaid === null)
    && Number.isFinite(item.litres) && item.litres >= 0 && item.litres <= 2000 && (item.kind !== 'fill' || item.litres > 0)
    && (item.odometerKm === null || (Number.isFinite(item.odometerKm) && item.odometerKm >= 0 && item.odometerKm < 10_000_000))
    && (item.kind !== 'reference' || (item.litres === 0 && item.odometerKm === null && item.fullTank === false && item.source !== 'receipt'))
    && typeof item.fullTank === 'boolean' && ['receipt', 'manual', 'regional'].includes(item.source)
    && (item.kind !== 'fill' || item.source === 'receipt')
    && typeof item.region === 'string' && item.region.length <= 120 && (item.source !== 'regional' || item.region.length > 0)
    && typeof item.sourceUrl === 'string' && item.sourceUrl.length <= 500 && (!item.sourceUrl || /^https:\/\//.test(item.sourceUrl))
    && typeof item.note === 'string' && item.note.length <= 1000;
}

export interface FuelPeriod {
  period: string; trips: number; covered: number; priced: number; calculatedLitres: number; estimatedLitres: number;
  efficiencyKmPerLitre: number | null; tripCost: Record<string, number>; paid: Record<string, number>;
}
export function aggregateFuel(sessions: Session[], entries: FuelEntry[], group: 'week' | 'month', timezone: string): FuelPeriod[] {
  const buckets = new Map<string, FuelPeriod & { km: number; measuredFuel: number }>();
  const keyFor = (at: string) => {
    const key = tripDayKey(new Date(at), timezone);
    if (group === 'month') return key.slice(0, 7);
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return tripDayKey(date, 'UTC');
  };
  const bucketFor = (at: string) => {
    const key = keyFor(at);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { period: key, trips: 0, covered: 0, priced: 0, calculatedLitres: 0, estimatedLitres: 0, efficiencyKmPerLitre: null, tripCost: {}, paid: {}, km: 0, measuredFuel: 0 }; buckets.set(key, bucket); }
    return bucket;
  };
  for (const trip of sessions) {
    const bucket = bucketFor(trip.session_start ?? trip.uploaded_at);
    const result = tripFuelEstimate(trip, entries), m = readFuelMetrics(trip);
    bucket.trips++;
    if (result.litres != null) { bucket.covered++; if (result.source === 'calculated') bucket.calculatedLitres += result.litres; else bucket.estimatedLitres += result.litres; }
    if (result.cost != null && result.price) { bucket.priced++; bucket.tripCost[result.price.currency] = (bucket.tripCost[result.price.currency] ?? 0) + result.cost; }
    if (m?.litres != null && m.coverage >= .9 && m.distanceCoverage >= .9 && m.distanceKm != null) { bucket.km += m.distanceKm; bucket.measuredFuel += m.litres; }
  }
  for (const entry of entries) if (entry.kind === 'fill') {
    const bucket = bucketFor(entry.at);
    bucket.paid[entry.currency] = (bucket.paid[entry.currency] ?? 0) + entry.totalPaid!;
  }
  return [...buckets.values()].map((bucket) => ({ ...bucket, efficiencyKmPerLitre: bucket.measuredFuel > 0 ? bucket.km / bucket.measuredFuel : null })).sort((a, b) => b.period.localeCompare(a.period));
}
/** Most recent price known at the time; a later fill-up never reprices an old trip. */
export function fuelPriceAt(entries: FuelEntry[], at: string) {
  return entries.filter((item) => Date.parse(item.at) <= Date.parse(at)).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}
export interface TankInterval { at: string; km: number; litres: number; kmPerLitre: number }
export function tankIntervals(entries: FuelEntry[]): TankInterval[] {
  const fills = entries.filter((item) => item.kind === 'fill').slice().sort((a, b) => a.at.localeCompare(b.at));
  let anchor: FuelEntry | null = null, litres = 0;
  const result: TankInterval[] = [];
  for (const fill of fills) {
    if (anchor) litres += fill.litres;
    if (fill.fullTank && fill.odometerKm != null) {
      if (anchor?.odometerKm != null && fill.odometerKm > anchor.odometerKm && litres > 0) {
        const km = fill.odometerKm - anchor.odometerKm;
        result.push({ at: fill.at, km, litres, kmPerLitre: km / litres });
      }
      anchor = fill; litres = 0;
    } else if (anchor?.odometerKm != null && fill.odometerKm != null && fill.odometerKm < anchor.odometerKm) {
      anchor = null; litres = 0; // Odometer reset or wrong entry: never bridge it.
    }
  }
  return result;
}
export function readFuelMetrics(session: Pick<Session, 'summary'>): FuelMetrics | null {
  const metrics = session.summary?.fuel as FuelMetrics | undefined;
  const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return metrics?.version === 1 && metrics.source === 'obd_flow'
    && nonnegative(metrics.coverage) && metrics.coverage <= 1 && nonnegative(metrics.distanceCoverage) && metrics.distanceCoverage <= 1
    && nonnegative(metrics.fuelSeconds) && nonnegative(metrics.distanceSeconds)
    && (metrics.duration === null || nonnegative(metrics.duration))
    && (metrics.litres === null || nonnegative(metrics.litres)) && (metrics.distanceKm === null || nonnegative(metrics.distanceKm)) ? metrics : null;
}
export function coveredTripDistance(session: Pick<Session,'summary'|'duration_seconds'>): number | null {
  const metrics = readFuelMetrics(session);
  if (metrics) return metrics.distanceKm != null && metrics.distanceCoverage >= .9 ? metrics.distanceKm : null;
  const speed = session.summary?.summaries?.find(item=>item.canonical_key === 'vehicle_speed');
  if (typeof speed?.avg !== 'number' || !Number.isFinite(speed.avg) || speed.avg < 0 || !session.duration_seconds || session.duration_seconds <= 0
    || typeof speed.duration_seconds !== 'number' || speed.duration_seconds < session.duration_seconds * .9) return null;
  return speed.avg * session.duration_seconds / 3600;
}
export function tripFuelEstimate(session: Session, entries: FuelEntry[]) {
  const at = session.session_start ?? session.uploaded_at;
  const metrics = readFuelMetrics(session);
  const distance = coveredTripDistance(session);
  const baseline = tankIntervals(entries).filter((item) => item.at <= at).at(-1);
  const calculated = metrics?.litres != null && metrics.coverage >= 0.9;
  const litres = calculated ? metrics.litres : baseline && distance != null && distance >= 0 ? distance / baseline.kmPerLitre : null;
  const price = fuelPriceAt(entries, at);
  return { litres, distance, source: calculated ? 'calculated' as const : litres != null ? 'estimated' as const : 'unavailable' as const, price, cost: litres != null && price ? litres * price.pricePerLitre : null, coverage: metrics?.coverage ?? 0, baseline };
}

export interface FuelComparison { deltaPct: number; currentCount: number; previousCount: number; period: string; bucket: string }
/** Compare consumption, not spending. Require similar speed/duration and enough covered trips. */
export function compareFuel(sessions: Session[], now = new Date()): FuelComparison | null {
  const end = now.getTime(), middle = end - 28 * 86400000, beginning = middle - 28 * 86400000;
  const groups = new Map<string, { current: { litres: number; km: number; count: number }; previous: { litres: number; km: number; count: number } }>();
  for (const trip of sessions) {
    const at = Date.parse(trip.session_start ?? trip.uploaded_at), m = readFuelMetrics(trip);
    if (at < beginning || at > end || !m || m.litres == null || m.distanceKm == null || m.coverage < .9 || m.distanceCoverage < .9 || m.distanceKm < 1 || !m.duration) continue;
    const speed = m.distanceKm / m.duration * 3600;
    const key = `${Math.floor(speed / 20)}:${m.duration < 900 ? 'short' : m.duration < 2700 ? 'medium' : 'long'}`;
    const group = groups.get(key) ?? { current: { litres: 0, km: 0, count: 0 }, previous: { litres: 0, km: 0, count: 0 } };
    const period = at >= middle ? group.current : group.previous;
    period.litres += m.litres; period.km += m.distanceKm; period.count++;
    groups.set(key, group);
  }
  return [...groups.entries()].filter(([, g]) => g.current.count >= 3 && g.previous.count >= 3 && g.current.km >= 20 && g.previous.km >= 20 && g.previous.litres > 0)
    .map(([bucket, g]) => ({ deltaPct: (g.current.litres / g.current.km / (g.previous.litres / g.previous.km) - 1) * 100, currentCount: g.current.count, previousCount: g.previous.count, period: now.toISOString().slice(0, 7), bucket }))
    .sort((a, b) => (b.currentCount + b.previousCount) - (a.currentCount + a.previousCount))[0] ?? null;
}
