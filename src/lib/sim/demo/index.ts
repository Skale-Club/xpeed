// The made-up account of the example mode (see mode.ts): the racing data API of docs/platform/API-V1.md answered from the browser, with nothing
// sent anywhere. Two games (Assetto Corsa and Automobilista 2), four tracks and four cars, nine sessions over three weeks of a driver who keeps
// getting faster, each with an out lap, an in lap and a voided lap, sectors, and a real lap file for every lap (made-up laps with known corners,
// src/lib/sim/synthetic-lap.ts, that vary a little from lap to lap) so Overview, Sessions, a session, Compare's corner analysis, Tracks and Cars
// can all be opened. Days are counted back from the real clock, so the example never ages out of "the last 30 days". Nobody real is in it.
//
// This module is loaded on demand (a dynamic import from v1-client.ts and account-tracks.ts) and only while the example is on.
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { buildSyntheticLap, exampleCorners, scaleCorners, type SynthCorner } from '@/lib/sim/synthetic-lap';
import type { V1Lap, V1Ref, V1Session } from '@/lib/sim/v1-client';
import { buildCatalog, fakeV1State, handleV1, type FakeResponse, type FakeV1State } from './fake-server';
import { buildInsights } from './insights';
import { gzipBytes, makeLayout, packLayout } from './track-fixture';

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = (n: number, name: string): V1Ref => ({ id: id('00000001', n), name });
const car = (n: number, name: string): V1Ref => ({ id: id('00000002', n), name });

const MONZA = track(1, 'Monza');
const IMOLA = track(2, 'Imola');
const INTERLAGOS = track(3, 'Interlagos');
const SPA = track(4, 'Spa-Francorchamps');
const FERRARI = car(1, 'Ferrari 488 GT3');
const PORSCHE = car(2, 'Porsche 911 GT3 R');
const MCLAREN = car(3, 'McLaren 720S GT3');
const BMW = car(4, 'BMW M4 GT3');

const LENGTH_M: Record<string, number> = { Monza: 5793, Imola: 4909, Interlagos: 4309, 'Spa-Francorchamps': 7004 };
const CAR_BRAND: Record<string, string> = { [FERRARI.id]: 'Ferrari', [PORSCHE.id]: 'Porsche', [MCLAREN.id]: 'McLaren', [BMW.id]: 'BMW' };
/** The games the tracks belong to, for the layouts. */
const TRACK_GAME: Record<string, string> = { [MONZA.id]: 'ac', [IMOLA.id]: 'ac', [INTERLAGOS.id]: 'ams2', [SPA.id]: 'ams2' };

const DAY_MS = 86_400_000;

interface Plan {
  days: number;
  hour: number;
  game: string;
  track: V1Ref;
  car: V1Ref;
  kind: V1Session['kind'];
  laps: number;
  /** About the lap time of the session, ms: it falls from one session to the next on the same track and car. */
  base: number;
  weather: string | null;
  air: number | null;
  trackTemp: number | null;
}

const PLANS: readonly Plan[] = [
  { days: 21, hour: 19, game: 'ac', track: MONZA, car: FERRARI, kind: 'practice', laps: 9, base: 108_400, weather: 'dry', air: 24, trackTemp: 31 },
  { days: 18, hour: 20, game: 'ams2', track: INTERLAGOS, car: MCLAREN, kind: 'practice', laps: 8, base: 84_600, weather: 'dry', air: 27, trackTemp: 36 },
  { days: 15, hour: 18, game: 'ac', track: IMOLA, car: PORSCHE, kind: 'practice', laps: 8, base: 104_200, weather: 'cloudy', air: 16, trackTemp: 19 },
  { days: 12, hour: 21, game: 'ac', track: MONZA, car: FERRARI, kind: 'qualifying', laps: 7, base: 107_100, weather: 'dry', air: 22, trackTemp: 28 },
  { days: 9, hour: 19, game: 'ams2', track: SPA, car: BMW, kind: 'practice', laps: 8, base: 141_800, weather: null, air: null, trackTemp: null },
  { days: 7, hour: 20, game: 'ams2', track: INTERLAGOS, car: MCLAREN, kind: 'race', laps: 10, base: 83_300, weather: 'dry', air: 25, trackTemp: 33 },
  { days: 4, hour: 18, game: 'ac', track: IMOLA, car: PORSCHE, kind: 'race', laps: 9, base: 102_900, weather: 'dry', air: 18, trackTemp: 22 },
  { days: 2, hour: 21, game: 'ac', track: MONZA, car: FERRARI, kind: 'practice', laps: 10, base: 105_600, weather: 'dry', air: 23, trackTemp: 29 },
  { days: 1, hour: 19, game: 'ams2', track: SPA, car: BMW, kind: 'practice', laps: 8, base: 139_700, weather: 'dry', air: 20, trackTemp: 24 },
];

/** A small fixed-seed generator: the example is the same every time it is opened. */
function generator(start: number) {
  let seed = start;
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const cornersFor = (trackName: string): SynthCorner[] => scaleCorners(exampleCorners(), LENGTH_M[trackName] / 4200);

/**
 * A lap of this track, driven by someone who varies a little: the hairpin's brake point moves, the speed through the last corner and when the
 * throttle comes on after the first one. `skill` (about -1 to 1) is how well the lap went, so the corner analysis has real findings.
 */
function driven(plan: Plan, lap: number, skill: number, random: () => number): LapFile {
  const corners = cornersFor(plan.track.name).map((corner, index) => {
    if (index === 0) return { ...corner, pickupDist: corner.apexDist + 25 - skill * 8 + (random() - 0.5) * 8 };
    if (index === 1) return { ...corner, brakeDist: corner.brakeDist - 14 * (random() - 0.2) + skill * 6 };
    if (index === 5) return { ...corner, minSpeedKmh: corner.minSpeedKmh + skill * 3 + (random() - 0.5) * 4 };
    return corner;
  });
  return buildSyntheticLap({ lengthM: LENGTH_M[plan.track.name], corners, hz: 10, trackName: plan.track.name, car: plan.car.name, game: plan.game, lapNumber: lap }).lap;
}

/** The same lap through the pits: slower, as an out or in lap is. The clock follows. */
const slowedBy = (lap: LapFile, factor: number): LapFile => ({
  ...lap,
  header: { ...lap.header, lap: { ...lap.header.lap, timeMs: Math.round(lap.header.lap.timeMs * factor) } },
  data: { ...lap.data, t: Float32Array.from(lap.data.t, (value) => value * factor) },
});

interface Example {
  state: FakeV1State;
  /** Every lap's samples, packed (gzip) only when a screen asks for the file. */
  files: Map<string, LapFile>;
}

let built: Example | null = null;

function build(now: number = Date.now()): Example {
  const random = generator(20261115);
  const midnight = Math.floor(now / DAY_MS) * DAY_MS;
  const state = fakeV1State({ devices: [] });
  const files = new Map<string, LapFile>();
  let n = 0;
  for (const [index, plan] of PLANS.entries()) {
    const startedAt = new Date(midnight - plan.days * DAY_MS + plan.hour * 3_600_000).toISOString();
    const session: V1Session = {
      id: id('00000003', index + 1), game: plan.game, track: plan.track, car: plan.car, kind: plan.kind, origin: 'companion', startedAt, endedAt: startedAt,
      weather: plan.weather, airTempC: plan.air, trackTempC: plan.trackTemp, lapCount: 0, bestLapMs: null,
    };
    state.sessions.push(session);
    let clock = Date.parse(startedAt);
    for (let lap = 1; lap <= plan.laps; lap++) {
      n++;
      const out = lap === 1;
      const into = lap === plan.laps && plan.laps > 6;
      const voided = lap % 6 === 4;
      // A spread of a second or so, quicker as the session goes on (skill climbs from -1 towards 1); the pit laps are slow.
      const skill = Math.max(-1, Math.min(1, (lap / plan.laps) * 2 - 1 + (random() - 0.5)));
      let file = driven(plan, lap, skill, random);
      file = slowedBy(file, (plan.base - skill * 150 + (random() - 0.5) * 360) / file.header.lap.timeMs);
      if (out) file = slowedBy(file, 1.17);
      else if (into) file = slowedBy(file, 1.07);
      const time = file.header.lap.timeMs;
      const length = LENGTH_M[plan.track.name];
      const at = (fraction: number) => Math.round(1000 * (file.data.t[file.data.dist.findIndex((d) => d >= fraction * length)] ?? 0));
      const s1 = at(0.31);
      const s2 = at(0.7) - s1;
      const sectors = [s1, s2, time - s1 - s2];
      const lapId = id('00000004', n);
      const lapStartedAt = new Date(clock).toISOString();
      clock += time + 3000;
      state.laps.push({
        id: lapId, game: plan.game, track: plan.track, car: plan.car, sessionId: session.id, lapNumber: lap, timeMs: time, valid: !voided, startedAt: lapStartedAt,
        sectorsMs: sectors, topSpeedKmh: Math.round(3.6 * Math.max(...file.data.speed)), fuelUsedL: null, inLap: into ? true : null, outLap: out ? true : null,
        sampleCount: file.header.sampleCount, sizeBytes: 90_000, reduced: false, formatVersion: 2, createdAt: new Date(clock).toISOString(), deviceName: null,
      } satisfies V1Lap);
      files.set(lapId, {
        ...file,
        header: {
          ...file.header, startedAt: lapStartedAt,
          lap: { number: lap, timeMs: time, valid: !voided, sectorsMs: sectors, ...(out ? { outLap: true } : {}), ...(into ? { inLap: true } : {}) },
        },
      });
    }
  }
  // The counters, as the server keeps them.
  for (const session of state.sessions) {
    const laps = state.laps.filter((entry) => entry.sessionId === session.id);
    const valid = laps.filter((entry) => entry.valid);
    session.lapCount = laps.length;
    session.bestLapMs = valid.length ? Math.min(...valid.map((entry) => entry.timeMs)) : null;
    session.endedAt = new Date(Math.max(...laps.map((entry) => Date.parse(entry.startedAt) + entry.timeMs))).toISOString();
    state.insights.set(session.id, buildInsights(session.id, laps));
  }
  buildCatalog(state, LENGTH_M);
  state.cars = state.cars.map((entry) => ({ ...entry, brand: CAR_BRAND[entry.id] ?? null, class: 'GT3' }));
  // Xpeed Companion would have sent the shape of each circuit: the example has them too.
  state.tracks = state.tracks.map((entry) => ({ ...entry, hasLayout: true, layoutId: layoutId(entry.id) }));
  state.requests.length = 0;
  return { state, files };
}

/** The example account, built once. */
export function example(): Example {
  built ??= build();
  return built;
}

/** Forgets what was built (tests). */
export function resetExample(): void {
  built = null;
  layouts.clear();
}

// ---------------------------------------------------------------------------------------------------------------- the racing data API

/** Answers one call of the racing data API (`path` is what follows `/api/sim/v1`). The social side has no part in the example: it is a 404. */
export async function answerDemo(method: string, path: string, params: Record<string, string>): Promise<FakeResponse> {
  const { state, files } = example();
  const file = /^\/laps\/([^/]+)\/file$/.exec(path);
  if (method === 'GET' && file) {
    const lapId = decodeURIComponent(file[1]);
    const raw = files.get(lapId);
    if (raw && !state.files.has(lapId)) state.files.set(lapId, await gzipLap(raw));
  }
  const answer = handleV1(state, method, path, params);
  state.requests.length = 0;
  return answer;
}

// ---------------------------------------------------------------------------------------------------------------- the track layouts

const layoutId = (trackId: string) => `example-layout-${trackId.slice(-2)}`;
const layouts = new Map<string, Promise<Uint8Array>>();

const layoutBytes = (entry: V1Ref): Promise<Uint8Array> => {
  let found = layouts.get(entry.id);
  if (!found) {
    const lap = buildSyntheticLap({ lengthM: LENGTH_M[entry.name], corners: cornersFor(entry.name), hz: 5, game: TRACK_GAME[entry.id] }).lap;
    const points = Array.from(lap.data.x, (x, i) => [x, lap.data.z[i]] as [number, number]);
    found = gzipBytes(packLayout(makeLayout({ game: TRACK_GAME[entry.id], name: entry.name, points, width: 7, closed: false, ideal: true, idealShift: 0.6 })));
    layouts.set(entry.id, found);
  }
  return found;
};

/** Answers `GET /api/sim/tracks` (the layouts "Xpeed Companion sent") and `GET /api/sim/tracks/<id>/file`; null for anything else. */
export async function answerLayouts(path: string): Promise<{ json?: unknown; bytes?: Uint8Array } | null> {
  const all = [MONZA, IMOLA, INTERLAGOS, SPA];
  if (path === '/api/sim/tracks') {
    const tracks = await Promise.all(all.map(async (entry) => ({
      id: layoutId(entry.id), game: TRACK_GAME[entry.id], trackName: entry.name, variant: null, title: null, lengthM: LENGTH_M[entry.name], size: (await layoutBytes(entry)).length,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })));
    return { json: { tracks } };
  }
  const file = /^\/api\/sim\/tracks\/([^/]+)\/file$/.exec(path);
  const entry = file && all.find((candidate) => layoutId(candidate.id) === decodeURIComponent(file[1]));
  return entry ? { bytes: await layoutBytes(entry) } : null;
}
