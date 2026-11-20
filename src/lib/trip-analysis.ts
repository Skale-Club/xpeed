// What happened on one trip, worked out from its recorded readings: the speed
// over time, how the time split between standing, town, road and motorway,
// stops and sudden speed changes, how the engine warmed up, and (hybrids) how
// much of the moving time ran on electricity alone. The trip page draws its
// dashboards from this; nothing here is stored.

import type { SessionRow } from '@/types/session';
import { matchCanonicalKey } from '@/lib/canonical-params';

type HeaderMapping = Record<string, { canonical_key: string } | null | undefined>;

/** The readings the trip dashboards use, in the units the importer stores (km/h, °C, rpm, %). */
export const TRIP_KEYS = {
  speed: 'vehicle_speed',
  rpm: 'engine_rpm',
  coolant: 'coolant_temp',
  soc: 'hybrid_battery_soc',
  load: 'engine_load',
} as const;
export type TripKey = keyof typeof TRIP_KEYS;

export interface TripPoint {
  /** Seconds since the trip started. */
  t: number;
  speed?: number;
  rpm?: number;
  coolant?: number;
  soc?: number;
  load?: number;
}

/** Below this the car counts as standing still (km/h). */
export const STOPPED_KMH = 3;
/** Speed bands: town below 50, road below 90, motorway from 90 (km/h). */
export const TOWN_KMH = 50;
export const ROAD_KMH = 90;
/** The engine counts as warm from this coolant temperature (°C). */
export const WARM_C = 70;
/** A change of speed this sharp is "sudden" (m/s²): firm braking, or a hard push on the pedal. */
export const HARD_BRAKE_MS2 = 3;
export const HARD_ACCEL_MS2 = 2.5;
/** Below this the engine counts as off (rpm). */
const ENGINE_ON_RPM = 300;
/**
 * Two readings further apart than this are a gap in the recording, never bridged (s). Stored trips
 * are thinned to about 2000 readings, so a long trip's normal spacing can be wider: the limit grows
 * to three times the trip's usual spacing.
 */
const MAX_GAP_S = 30;
/** Speed changes are judged only between readings this close together (s). */
const MAX_ACCEL_GAP_S = 5;

export interface DrivingMix { stopped: number; town: number; road: number; motorway: number }

export interface TripAnalysis {
  points: TripPoint[];
  has: Record<TripKey, boolean>;
  /** Seconds of recording the bands below cover (gaps left out). */
  recordedSeconds: number;
  topSpeed: number | null;
  /** Average while moving, km/h. */
  movingAvgSpeed: number | null;
  /** Seconds in each speed band. */
  mix: DrivingMix | null;
  stops: number;
  hardBrakes: number;
  hardAccels: number;
  maxRpm: number | null;
  /** Seconds standing still with the engine running. */
  idleSeconds: number | null;
  warmup: { startC: number; maxC: number; warmAfterSeconds: number | null; startedWarm: boolean } | null;
  /** Hybrids: share (0..1) of the moving time with the engine off. */
  electricShare: number | null;
  soc: { start: number; end: number; min: number; max: number } | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Which column holds each reading: the importer's own mapping first, then the column name. */
export function tripColumns(rows: Pick<SessionRow, 'data'>[], headerMapping: HeaderMapping): Partial<Record<TripKey, string>> {
  const columns: Partial<Record<TripKey, string>> = {};
  const headers = new Set<string>(Object.keys(headerMapping));
  for (const row of rows.slice(0, 5)) for (const h of Object.keys(row.data ?? {})) headers.add(h);
  for (const header of headers) {
    const canonical = headerMapping[header]?.canonical_key ?? matchCanonicalKey(header)?.canonical_key;
    for (const [key, wanted] of Object.entries(TRIP_KEYS) as [TripKey, string][]) {
      if (canonical === wanted && !columns[key]) columns[key] = header;
    }
  }
  return columns;
}

export function analyseTrip(
  rows: Pick<SessionRow, 't_seconds' | 'data'>[],
  headerMapping: HeaderMapping,
  options: { hybrid?: boolean } = {},
): TripAnalysis {
  const columns = tripColumns(rows, headerMapping);
  const points: TripPoint[] = rows
    .filter((r) => finite(r.t_seconds))
    .map((r) => {
      const p: TripPoint = { t: r.t_seconds! };
      for (const [key, header] of Object.entries(columns) as [TripKey, string][]) {
        const v = r.data?.[header];
        if (finite(v) && v >= 0) p[key] = v;
      }
      return p;
    })
    .sort((a, b) => a.t - b.t);
  const has = Object.fromEntries((Object.keys(TRIP_KEYS) as TripKey[]).map((k) => [k, points.some((p) => p[k] != null)])) as Record<TripKey, boolean>;

  const spacings = points.slice(1).map((p, i) => p.t - points[i].t).filter((g) => g > 0).sort((x, y) => x - y);
  const maxGap = Math.max(MAX_GAP_S, 3 * (spacings[Math.floor(spacings.length / 2)] ?? 0));
  let recordedSeconds = 0;
  const mix: DrivingMix = { stopped: 0, town: 0, road: 0, motorway: 0 };
  let movingSeconds = 0, movingDistance = 0;
  let idleSeconds = 0, rpmMovingSeconds = 0, electricSeconds = 0;
  let stops = 0, hardBrakes = 0, hardAccels = 0;
  let wasMoving = false;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const gap = b.t - a.t;
    if (gap <= 0 || gap > maxGap || a.speed == null || b.speed == null) continue;
    recordedSeconds += gap;
    const speed = (a.speed + b.speed) / 2;
    if (speed < STOPPED_KMH) mix.stopped += gap;
    else if (speed < TOWN_KMH) mix.town += gap;
    else if (speed < ROAD_KMH) mix.road += gap;
    else mix.motorway += gap;
    if (speed >= STOPPED_KMH) { movingSeconds += gap; movingDistance += speed * gap; }
    if (a.rpm != null && b.rpm != null) {
      // Only a stretch with the engine on (or off) at both ends counts as such.
      const engineOn = Math.min(a.rpm, b.rpm) >= ENGINE_ON_RPM;
      const engineOff = Math.max(a.rpm, b.rpm) < ENGINE_ON_RPM;
      if (speed < STOPPED_KMH && engineOn) idleSeconds += gap;
      if (speed >= STOPPED_KMH) { rpmMovingSeconds += gap; if (engineOff) electricSeconds += gap; }
    }
    if (gap <= MAX_ACCEL_GAP_S) {
      const accel = (b.speed - a.speed) / 3.6 / gap;
      if (accel <= -HARD_BRAKE_MS2) hardBrakes++;
      else if (accel >= HARD_ACCEL_MS2) hardAccels++;
    }
  }
  // A stop is the car coming to a standstill after moving; a halting reading in between doesn't count twice.
  for (const p of points) {
    if (p.speed == null) continue;
    if (p.speed >= STOPPED_KMH) wasMoving = true;
    else if (wasMoving) { stops++; wasMoving = false; }
  }

  const speeds = points.flatMap((p) => (p.speed != null ? [p.speed] : []));
  const rpms = points.flatMap((p) => (p.rpm != null ? [p.rpm] : []));
  const coolant = points.filter((p) => p.coolant != null);
  const socs = points.flatMap((p) => (p.soc != null ? [p.soc] : []));

  let warmup: TripAnalysis['warmup'] = null;
  if (coolant.length >= 2) {
    const startC = coolant[0].coolant!;
    const warmAt = coolant.find((p) => p.coolant! >= WARM_C);
    warmup = {
      startC,
      maxC: Math.max(...coolant.map((p) => p.coolant!)),
      startedWarm: startC >= WARM_C,
      warmAfterSeconds: warmAt ? warmAt.t - coolant[0].t : null,
    };
  }

  return {
    points,
    has,
    recordedSeconds,
    topSpeed: speeds.length ? Math.max(...speeds) : null,
    movingAvgSpeed: movingSeconds > 0 ? movingDistance / movingSeconds : null,
    mix: recordedSeconds > 0 ? mix : null,
    stops,
    hardBrakes,
    hardAccels,
    maxRpm: rpms.length ? Math.max(...rpms) : null,
    idleSeconds: has.rpm && has.speed ? idleSeconds : null,
    warmup,
    electricShare: options.hybrid && rpmMovingSeconds >= 30 ? electricSeconds / rpmMovingSeconds : null,
    soc: socs.length >= 2 ? { start: socs[0], end: socs[socs.length - 1], min: Math.min(...socs), max: Math.max(...socs) } : null,
  };
}
