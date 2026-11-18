import { incomparableReason } from './analysis.ts';
import { compareCorners, type CornerCause, type CornerDelta } from './corner-compare.ts';
import { lapInsights, type Insight } from './insights.ts';
import type { LapFile, LapHeader } from './lap-file.ts';
import { round } from './lap-series.ts';
import { referenceDifferences, referenceVersionContext } from './reference-context.ts';

const MAX_CORNERS = 5;
const MAX_INSIGHTS = 5;

type LapInput = { id: string; lap: LapFile };
type LapLabel = { id: string; number: number; timeMs: number };
type LikelyCause = Exclude<CornerCause, 'wrongGear' | 'none'>;
type UnavailableReason = 'same_lap' | 'invalid_lap' | 'car' | 'game' | 'track' | 'length' | 'coordinates' | 'channels';

export type DrivingEvidence =
  | { status: 'unavailable'; reason: UnavailableReason }
  | {
    status: 'ready';
    study: LapLabel;
    reference: LapLabel;
    lapDeltaS: number;
    conditions: string[];
    versions: ReturnType<typeof referenceVersionContext>;
    channels: { study: string[]; reference: string[] };
    corners: ReturnType<typeof cornerFact>[];
    insights: ReturnType<typeof insightFact>[];
    comparisonPath: string;
    limitations: string[];
  };

const unavailable = (reason: UnavailableReason): DrivingEvidence => ({ status: 'unavailable', reason });
const normalize = (s?: string) => s?.trim().toLowerCase() ?? '';
const known = (s?: string) => !['', 'unknown', 'n/a', 'unspecified'].includes(normalize(s));
const finite = (value: number | null | undefined, places = 3) =>
  typeof value === 'number' && Number.isFinite(value) ? round(value, places) : null;

function cleanLap(lap: LapFile) {
  const { valid, inLap, outLap, timeMs, number } = lap.header.lap;
  return valid === true && !inLap && !outLap && Number.isInteger(timeMs) && timeMs > 0 && Number.isInteger(number) && number >= 0;
}

function lapLabel({ id, lap }: LapInput): LapLabel {
  const { number, timeMs } = lap.header.lap;
  return { id, number, timeMs };
}

function clockQuality({ header, data: { t, dist } }: LapFile) {
  const n = header.sampleCount;
  if (n < 2 || t?.length !== n || dist?.length !== n) return null;
  let repeats = 0;
  let longestGap = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(t[i]) || !Number.isFinite(dist[i]) || dist[i] < 0) return null;
    if (i === 0) continue;
    const step = t[i] - t[i - 1];
    if (step < 0 || dist[i] < dist[i - 1] - 5) return null;
    if (step === 0) repeats++;
    longestGap = Math.max(longestGap, step);
  }
  const duration = t[n - 1] - t[0];
  // Use the ingest tolerance for elapsed time and the largest clock gap.
  if (!(duration > 0) || Math.abs(duration * 1000 - header.lap.timeMs) > header.lap.timeMs * 0.005 || longestGap > 2) return null;
  return {
    lowRate: header.sampleRateHz < 20 || (n - 1 - repeats) / duration < 19.5,
    irregular: repeats / (n - 1) > 0.01 || longestGap > 0.25,
  };
}

function usableSpeed({ header, data }: LapFile) {
  if (data.speed?.length !== header.sampleCount) return false;
  let moving = 0;
  let gaps = 0;
  for (const value of data.speed) {
    if (Number.isNaN(value)) gaps++;
    else if (!Number.isFinite(value) || value < 0 || value > 150) return false;
    else if (value > 0) moving++;
  }
  return moving >= 2 && gaps / header.sampleCount <= 0.2;
}

function comparableChannels(lap: LapFile, usePosition: boolean): LapFile {
  const { t, dist, speed } = lap.data;
  const data: LapFile['data'] = { t, dist, speed };
  const add = (id: string, min: number, max: number) => {
    const column = lap.data[id];
    // The analysis fills missing pedal/steering samples with zero. Keep incomplete
    // optional inputs out so the coach cannot mistake gaps for driver actions.
    if (column?.length === lap.header.sampleCount && column.every((v) => Number.isFinite(v) && v >= min && v <= max)) {
      data[id] = column;
    }
  };
  add('brake', -0.001, 1.001);
  add('throttle', -0.001, 1.001);
  add('steer', -1.001, 1.001);
  add('gear', -1, Infinity);
  if (usePosition && !lap.header.checks?.some((check) => check === 'map_mirrored' || check === 'position_jump')) {
    add('x', -Infinity, Infinity);
    add('z', -Infinity, Infinity);
    if (!data.x || !data.z) {
      delete data.x;
      delete data.z;
    }
  }
  // A longitudinal acceleration trace does not indicate the brake pedal position.
  return { ...lap, data };
}

function conditionContext(study: LapFile, reference: LapFile): string[] {
  const differences = referenceDifferences(study, reference);
  const a = study.header, b = reference.header;
  const labels = (name: string, studyLabel: string | undefined, referenceLabel: string | undefined, differs: boolean) => {
    if (!known(studyLabel) || !known(referenceLabel)) return `${name} unknown for one or both laps.`;
    return differs ? `Recorded ${name.toLowerCase()} differs.` : `Recorded ${name.toLowerCase()} labels match.`;
  };
  const hasFuel = (lap: LapFile) => lap.data.fuel?.some((value) => Number.isFinite(value) && value >= 0);
  const fuel = !hasFuel(study) || !hasFuel(reference) ? 'Fuel load unknown for one or both laps.'
    : differences.includes('fuel') ? 'The first recorded fuel values differ by at least 5 L.'
    : 'The first recorded fuel values differ by less than 5 L.';
  const temperature = (name: string, x?: number, y?: number) =>
    !Number.isFinite(x) || !Number.isFinite(y) ? `${name} unknown for one or both laps.`
      : x === y ? `Recorded ${name.toLowerCase()} matches.` : `Recorded ${name.toLowerCase()} differs.`;
  return [
    labels('Weather', a.weather, b.weather, differences.includes('weather')),
    labels('Tyre compound', a.tyreCompound, b.tyreCompound, differences.includes('tyres')),
    fuel,
    temperature('Air temperature', a.airTempC, b.airTempC),
    temperature('Track temperature', a.trackTempC, b.trackTempC),
    'Setup and track grip were unverified.',
  ];
}

function hypothesis(cause?: Insight['cause']): LikelyCause | null {
  return cause === 'wrongGear' || cause === 'none' || cause === 'unknownCause' ? null : cause ?? null;
}

function cornerFact(c: CornerDelta, withSteering: boolean) {
  const lineOffsetM = finite(c.lineOffsetM, 1);
  const studyGear = finite(c.gear.study, 0), referenceGear = finite(c.gear.reference, 0);
  const missing: Array<CornerDelta['missing'][number] | 'gear' | 'steer'> = [...c.missing];
  if (lineOffsetM === null && !missing.includes('position')) missing.push('position');
  if (studyGear === null || referenceGear === null) missing.push('gear');
  if (!withSteering) missing.push('steer');
  const likelyCause = c.dominantCause === 'line' && lineOffsetM === null ? null : hypothesis(c.dominantCause);
  return {
    index: c.index,
    startDist: finite(c.startDist, 1),
    apexDist: finite(c.apexDist, 1),
    endDist: finite(c.endDist, 1),
    deltaTime: finite(c.deltaTime),
    entrySpeedKmh: finite(c.entrySpeedKmh, 1),
    minSpeedKmh: finite(c.minSpeedKmh, 1),
    exitSpeedKmh: finite(c.exitSpeedKmh, 1),
    brakePointM: finite(c.brakePointM, 1),
    brakePeak: finite(c.brakePeak),
    trailBrakeM: finite(c.trailBrakeM, 1),
    throttlePickupM: finite(c.throttlePickupM, 1),
    gear: { study: studyGear, reference: referenceGear, differs: studyGear === null || referenceGear === null ? null : c.gear.differs },
    lineOffsetM,
    missing,
    likelyCause,
    heuristicConfidence: likelyCause ? finite(c.confidence, 2) : null,
  };
}

function insightFact(i: Insight) {
  const likelyCause = hypothesis(i.cause);
  return {
    kind: i.kind,
    corner: finite(i.corner, 0),
    seconds: finite(i.seconds),
    meters: finite(i.meters, 1),
    kmh: finite(i.kmh, 1),
    sector: finite(i.sector, 0),
    severity: i.severity,
    likelyCause,
    heuristicConfidence: likelyCause ? finite(i.confidence, 2) : null,
  };
}

function versionContext(study: LapHeader, reference: LapHeader) {
  const versions = referenceVersionContext(study, reference);
  const a = study.recorder, b = reference.recorder;
  return {
    gameBuild: known(a?.gameBuild) && known(b?.gameBuild) ? versions.gameBuild : 'unknown' as const,
    coordinatesUnknown: versions.coordinatesUnknown
      || (study.game !== 'acevo' && (!known(a?.coordinateFrame) || !known(b?.coordinateFrame))),
  };
}

/** Bounded observations for an automatic same-car, same-layout coaching comparison. */
export function summarizeDriving(study: LapInput, reference: LapInput): DrivingEvidence {
  if (study.id === reference.id) return unavailable('same_lap');
  const a = study.lap, b = reference.lap;
  if (!cleanLap(a) || !cleanLap(b)) return unavailable('invalid_lap');
  const clockA = clockQuality(a), clockB = clockQuality(b);
  if (!clockA || !clockB) return unavailable('channels');
  const reason = incomparableReason(a, b);
  if (reason) return unavailable(reason);
  const carA = normalize(a.header.car.name), carB = normalize(b.header.car.name);
  if (!carA || carA !== carB) return unavailable('car');
  const lengthA = a.header.track.lengthM, lengthB = b.header.track.lengthM;
  if (lengthA && lengthB && Math.abs(lengthA - lengthB) / Math.max(lengthA, lengthB) > 0.03) return unavailable('length');
  const frameA = a.header.recorder?.coordinateFrame?.trim(), frameB = b.header.recorder?.coordinateFrame?.trim();
  if (known(frameA) && known(frameB) && frameA !== frameB) return unavailable('coordinates');
  if (!usableSpeed(a) || !usableSpeed(b)) return unavailable('channels');

  const versions = versionContext(a.header, b.header);
  const maskedA = comparableChannels(a, !versions.coordinatesUnknown);
  const maskedB = comparableChannels(b, !versions.coordinatesUnknown);
  const comparison = compareCorners(maskedA, maskedB);
  if (!comparison.comparable) return unavailable(comparison.reason === 'length' ? 'length' : 'channels');

  const corners = comparison.corners
    .filter((corner) => Number.isFinite(corner.deltaTime) && round(corner.deltaTime) > 0)
    .sort((x, y) => y.deltaTime - x.deltaTime || x.index - y.index)
    .slice(0, MAX_CORNERS)
    .map((corner) => cornerFact(corner, Boolean(maskedA.data.steer && maskedB.data.steer)));
  const insights = lapInsights(maskedA, maskedB, { max: MAX_INSIGHTS }).map(insightFact);
  const limitations = [
    'This is an observed comparison. Conditions and technique may differ, and time gains are uncertain.',
    'Lap gap uses the reported lap times. Corner gaps use recorded time aligned by lap distance.',
    'Corner indices are inferred from telemetry in reference-lap order. Distances refer to the study lap.',
    'Deltas are study minus reference. Positive time is a loss, positive brake/pickup distance is later, and positive line offset is left.',
    'Likely causes and confidence are heuristic. Gear differences are observations only.',
    'Missing or gapped optional inputs are omitted. Stale game samples may affect estimates.',
  ];
  if (versions.coordinatesUnknown) limitations.push('Coordinate frame unknown for one or both laps. Comparison uses pace and driver inputs without world-position data.');
  if (versions.gameBuild === 'unknown') limitations.push('Game build unknown for one or both laps.');
  if (versions.gameBuild === 'different') limitations.push('Game builds differ. Physics and telemetry behavior may have changed.');
  if (clockA.lowRate || clockB.lowRate) limitations.push('Low sample rate on one or both laps limits precision for timing, pedals and apex estimates.');
  if (clockA.irregular || clockB.irregular) limitations.push('Clock gaps or repeated samples reduce precision on one or both laps.');
  if (!comparison.corners.length) limitations.push('No usable corner matches were found.');
  else if (comparison.unmatchedStudy.length || comparison.unmatchedReference.length) limitations.push('Some inferred corners could not be matched.');

  return {
    status: 'ready',
    study: lapLabel(study),
    reference: lapLabel(reference),
    lapDeltaS: comparison.headerDelta,
    conditions: conditionContext(a, b),
    versions,
    channels: { study: Object.keys(maskedA.data), reference: Object.keys(maskedB.data) },
    corners,
    insights,
    comparisonPath: `/virtual/compare?${new URLSearchParams({ a: study.id, b: reference.id })}`,
    limitations,
  };
}
