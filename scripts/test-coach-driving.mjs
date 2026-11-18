// Network-free deterministic checks. Node 24 loads the same TypeScript as the Edge function.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeDriving } from '../src/lib/sim/coach-driving.ts';
import { buildSyntheticLap, exampleCorners, scaleCorners } from '../src/lib/sim/synthetic-lap.ts';

const recorder = (source, properties = {}) => ({
  app: 'xpeed-companion',
  version: '0.8.2',
  build: 'unknown',
  source,
  gameBuild: 'test-build',
  coordinateFrame: 'world-xz-v1',
  ...properties,
});

function makePair({ studyOptions = {}, referenceOptions = {} } = {}) {
  const referenceCorners = exampleCorners();
  const studyCorners = referenceCorners.map((corner, i) => i === 0 ? {
    ...corner,
    brakeDist: corner.brakeDist - 24,
    pickupDist: corner.apexDist + 49,
    minSpeedKmh: corner.minSpeedKmh - 7,
    exitSpeedKmh: corner.exitSpeedKmh - 5,
    brakePeak: 0.8,
    gear: 2,
  } : corner);
  const makeLap = (corners, lapNumber, options) => {
    const { lap } = buildSyntheticLap({ lengthM: 4200, corners, hz: 60, lapNumber, ...options });
    lap.header.recorder = recorder(lap.header.game);
    return lap;
  };
  return [
    { id: 'study lap', lap: makeLap(studyCorners, 2, studyOptions) },
    { id: 'reference&lap', lap: makeLap(referenceCorners, 1, referenceOptions) },
  ];
}

test('measures shifts in braking, throttle and pace in the expected units', () => {
  const [study, reference] = makePair({ studyOptions: { car: '  SYNTHETIC GT  ' } });
  const result = summarizeDriving(study, reference);
  assert.equal(result.status, 'ready');
  assert.equal(result.lapDeltaS, (study.lap.header.lap.timeMs - reference.lap.header.lap.timeMs) / 1000);
  assert(result.lapDeltaS > 0.5);
  assert.equal(result.comparisonPath, '/virtual/compare?a=study+lap&b=reference%26lap');
  const first = result.corners[0];
  assert.equal(first.index, 1);
  assert(first.startDist < first.apexDist && first.apexDist < first.endDist);
  assert(first.deltaTime > 0.4);
  assert(Math.abs(first.brakePointM - (-24)) < 3);
  assert(Math.abs(first.throttlePickupM - 24) < 3);
  assert(Math.abs(first.brakePeak - (-0.1)) < 0.03);
  assert(Math.abs(first.minSpeedKmh - (-7)) < 1);
  assert.equal(first.likelyCause, 'brakesEarly');
  assert(first.heuristicConfidence > 0);
  assert.deepEqual(first.gear, { study: 2, reference: 3, differs: true });
  assert(Math.abs(first.lineOffsetM) < 0.5);
  assert(result.insights.some((insight) => insight.kind === 'brakeEarlier' && insight.corner === 1));
  assert.deepEqual(summarizeDriving(study, reference), result);
});

test('keeps time observations and suppresses missing or incomplete driver inputs', () => {
  const [study, reference] = makePair();
  // g_long is present; deceleration must not be represented as a measured pedal action.
  delete study.lap.data.brake;
  study.lap.data.throttle[300] = NaN;
  study.lap.data.gear.fill(NaN);
  study.lap.data.steer[300] = Infinity;
  delete study.lap.data.z;
  const result = summarizeDriving(study, reference);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.channels.study, ['t', 'dist', 'speed']);
  assert.equal(result.corners[0].index, 1);
  const first = result.corners[0];
  assert(first.deltaTime > 0.4);
  for (const key of ['brakePointM', 'brakePeak', 'trailBrakeM', 'throttlePickupM', 'lineOffsetM']) {
    assert.equal(first[key], null, key);
  }
  assert.deepEqual(new Set(first.missing), new Set(['brake', 'throttle', 'position', 'gear', 'steer']));
  assert.deepEqual(first.gear, { study: null, reference: 3, differs: null });
  assert(!result.insights.some((insight) => insight.kind === 'brakeEarlier'));
  assert(!result.corners.some((corner) => ['brakesEarly', 'brakesLate', 'latePickup', 'line'].includes(corner.likelyCause)));
});

test('treats a gear difference as an observation even when the analysis picks it as a candidate cause', () => {
  const corners = exampleCorners().map((corner, i) => i === 0 ? {
    ...corner, gear: 2, minSpeedKmh: corner.minSpeedKmh - 1, exitSpeedKmh: corner.exitSpeedKmh - 1,
  } : corner);
  const result = summarizeDriving(...makePair({ studyOptions: { corners } }));
  assert.equal(result.status, 'ready');
  const first = result.corners[0];
  assert(first.deltaTime > 0.02);
  assert.equal(first.gear.differs, true);
  assert.equal(first.likelyCause, null);
  assert.equal(first.heuristicConfidence, null);
  assert(!JSON.stringify(result).includes('wrongGear'));
});

test('rejects other games, tracks and layouts, cars, lengths, and explicit coordinate mismatches', () => {
  const cases = [
    ['game', (a) => { a.header.game = 'ac'; }],
    ['track', (a) => { a.header.track.name = 'Other ring'; }],
    ['track', (a) => { a.header.track.variant = 'short'; }],
    ['car', (a) => { a.header.car.name = 'Synthetic GT Evo'; }],
    ['length', (a) => { a.header.track.lengthM = 3000; }],
    ['coordinates', (a) => { a.header.recorder.coordinateFrame = 'world-mirrored-v1'; }],
    ['invalid_lap', (a) => { a.header.lap.valid = false; }],
    ['invalid_lap', (a) => { a.header.lap.inLap = true; }],
    ['invalid_lap', (a) => { a.header.lap.outLap = true; }],
    ['channels', (a) => { a.header.lap.timeMs += 10000; }],
    ['channels', (a) => { a.data.speed.fill(NaN); }],
    ['channels', (a) => { a.data.speed.fill(0); }],
    ['channels', (a) => { delete a.data.speed; }],
    ['channels', (a) => { delete a.data.t; }],
  ];
  for (const [reason, mutate] of cases) {
    const pair = makePair();
    mutate(pair[0].lap);
    assert.deepEqual(summarizeDriving(...pair), { status: 'unavailable', reason });
  }
  const pair = makePair({ referenceOptions: { lengthM: 4600, corners: scaleCorners(exampleCorners(), 4600 / 4200) } });
  assert.deepEqual(summarizeDriving(...pair), { status: 'unavailable', reason: 'length' });
  const [study] = pair;
  assert.deepEqual(summarizeDriving(study, study), { status: 'unavailable', reason: 'same_lap' });
});

test('withholds positions for unknown EVO frames and rejects known mirrored frames', () => {
  const [study, reference] = makePair({ studyOptions: { game: 'acevo' }, referenceOptions: { game: 'acevo' } });
  study.lap.header.recorder = recorder('acevo', { coordinateFrame: undefined, gameBuild: undefined, build: 'older' });
  reference.lap.header.recorder = recorder('acevo', { coordinateFrame: 'acevo-reflected-x-v1' });
  const result = summarizeDriving(study, reference);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.versions, { coordinatesUnknown: true, gameBuild: 'unknown' });
  assert(result.limitations.some((limit) => limit.includes('Coordinate frame unknown')));
  assert(result.limitations.some((limit) => limit.includes('Game build unknown')));
  assert(!result.channels.study.includes('x'));
  assert(!result.channels.reference.includes('z'));
  assert(result.corners.every((corner) => corner.lineOffsetM === null && corner.missing.includes('position')));
  assert(result.corners[0].brakePointM < -20);
  // An unstamped legacy recorder version by itself does not resolve the frame.
  study.lap.data.x.fill(8000);
  assert.deepEqual(summarizeDriving(study, reference), result);
  study.lap.header.recorder.build = 'd821333';
  assert.deepEqual(summarizeDriving(study, reference), { status: 'unavailable', reason: 'coordinates' });
});

test('surfaces unknown conditions and distinguishable conditions without raw metadata', () => {
  const [study, reference] = makePair();
  study.lap.header.weather = 'unspecified';
  reference.lap.header.weather = 'rain';
  study.lap.header.tyreCompound = reference.lap.header.tyreCompound = 'compound-test';
  study.lap.header.trackTempC = 30;
  reference.lap.header.trackTempC = 40;
  study.lap.data.fuel = new Float32Array(study.lap.header.sampleCount).fill(30);
  reference.lap.data.fuel = new Float32Array(reference.lap.header.sampleCount).fill(15);
  study.lap.header.recorder.gameBuild = 'next-build';
  delete study.lap.header.recorder.coordinateFrame;
  const result = summarizeDriving(study, reference);
  assert.equal(result.status, 'ready');
  assert(result.conditions.includes('Weather unknown for one or both laps.'));
  assert(result.conditions.includes('Air temperature unknown for one or both laps.'));
  assert(result.conditions.includes('Recorded tyre compound labels match.'));
  assert(result.conditions.includes('Recorded track temperature differs.'));
  assert(result.conditions.includes('The first recorded fuel values differ by at least 5 L.'));
  assert.equal(result.versions.gameBuild, 'different');
  assert(result.versions.coordinatesUnknown);
  assert(!JSON.stringify(result).includes('compound-test'));
});

test('flags low effective sample rates and repeated recorder clocks', () => {
  const [study, reference] = makePair({ studyOptions: { hz: 10 } });
  study.lap.header.sampleRateHz = 60; // The cadence from the clock is authoritative.
  for (let i = 4; i < study.lap.data.t.length - 1; i += 4) study.lap.data.t[i] = study.lap.data.t[i - 1];
  const result = summarizeDriving(study, reference);
  assert.equal(result.status, 'ready');
  assert(result.limitations.some((limit) => limit.includes('Low sample rate')));
  assert(result.limitations.some((limit) => limit.includes('repeated samples')));
});

test('returns at most five losses and five insights with finite numbers and no raw samples', () => {
  const referenceCorners = Array.from({ length: 9 }, (_, i) => ({
    brakeDist: 200 + 430 * i, apexDist: 310 + 430 * i, exitDist: 395 + 430 * i,
    entrySpeedKmh: 210, minSpeedKmh: 95, exitSpeedKmh: 140,
  }));
  const studyCorners = referenceCorners.map((corner, i) => ({ ...corner, minSpeedKmh: corner.minSpeedKmh - 3 - i }));
  const [study, reference] = makePair({ studyOptions: { corners: studyCorners }, referenceOptions: { corners: referenceCorners } });
  // Zero motion in both position channels yields no finite line estimate.
  reference.lap.data.x.fill(0);
  reference.lap.data.z.fill(0);
  const result = summarizeDriving(study, reference);
  assert.equal(result.status, 'ready');
  assert.equal(result.corners.length, 5);
  assert.equal(result.insights.length, 5);
  assert(result.corners.every((corner, i, corners) => corner.deltaTime > 0 && (i === 0 || corner.deltaTime <= corners[i - 1].deltaTime)));
  assert(result.corners.every((corner) => corner.lineOffsetM === null));
  const verifyJson = (value) => {
    if (typeof value === 'number') assert(Number.isFinite(value));
    if (value === null || typeof value !== 'object') return;
    assert(!ArrayBuffer.isView(value));
    assert(!('grid' in value) && !('data' in value) && !('samples' in value));
    Object.values(value).forEach(verifyJson);
  };
  verifyJson(result);
  assert(JSON.stringify(result).length < 6000);
});
