// Screen harness only: a fake of the racing data API (docs/platform/API-V1.md) with realistic data, served by vite.harness.config.ts
// at /api/sim/v1/*. Several tracks and cars, 60 laps across six sessions in the last ten days (sectors, an out lap, an in lap and voided laps in
// each) and, behind them, about twenty shorter sessions over the last seven months (a driver who gets faster, with gaps and streaks), so the
// Overview dashboard has shape at every period. A real lap file for every lap, so Overview, Sessions, a session, the track and car pages and
// Compare can be clicked through without a server. Days are counted back from the real clock, so the data never ages out of "the last 30 days".
// The laps are made-up laps with known corners (src/lib/sim/synthetic-lap.ts): each driver varies a little from lap to lap (a brake point,
// the speed through a corner, when the throttle comes on), so the corner analysis has something to find. The layouts of Monza and Spa are
// served as the ones "Xpeed Companion sent" (GET /api/sim/tracks).
//
//   HARNESS_NO_LAPS=1   an account with nothing in it (the empty states)
//   HARNESS_ONE_LAP=1   an account with one lap, flagged not valid by the game (an out lap): the dashboard's "few data" state
//   HARNESS_API_DOWN=1  every call fails with 503 (the error state); /api/sim/v1/__fail?on=1 and ?on=0 switch it while the harness runs
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { buildSyntheticLap, exampleCorners, scaleCorners, type SynthCorner } from '@/lib/sim/synthetic-lap';
import type { V1CarItem, V1Lap, V1Ref, V1Session, V1TrackItem } from '@/lib/sim/v1-client';
import { gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { buildCatalog, fakeV1State, handleV1, type FakeV1State } from '@/test/v1-fake-server';
import { buildInsights } from '@/test/v1-insights';
import { handleSocial, handlePublic, type FakeSocialState } from '@/test/social-fake-server';
import { buildSocial } from './sim-social';

let seed = 20261113;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = (n: number, name: string): V1Ref => ({ id: id('00000001', n), name });
const car = (n: number, name: string): V1Ref => ({ id: id('00000002', n), name });

const TRACKS = { monza: track(1, 'Monza'), spa: track(2, 'Spa-Francorchamps'), bahrain: track(3, 'Bahrain International Circuit'), imola: track(4, 'Imola'), monzaAc: track(5, 'Monza'), interlagos: track(6, 'Interlagos') };
const CARS = { ferrari: car(1, 'Ferrari 499P'), toyota: car(2, 'Toyota GR010'), porsche: car(3, 'Porsche 911 GT3 R'), ferrari488: car(4, 'Ferrari 488 GT3'), ginetta: car(5, 'Ginetta G40') };
const LENGTH_M: Record<string, number> = { Monza: 5793, 'Spa-Francorchamps': 7004, 'Bahrain International Circuit': 5412, Imola: 4909, Interlagos: 4309 };

// Days are counted back from the real clock (UTC midnight), so "the last 30 days" is always full.
const DAY_MS = 86_400_000;
const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const ago = (days: number, hour: number, minute = 0) => new Date(midnight - days * DAY_MS + hour * 3_600_000 + minute * 60_000).toISOString();

interface Plan {
  game: string; track: V1Ref; car: V1Ref; kind: V1Session['kind']; startedAt: string; laps: number; base: number; weather: string | null; air: number | null; trackTemp: number | null;
  origin: V1Session['origin'];
}
const RECENT: Plan[] = [
  { game: 'lmu', track: TRACKS.monza, car: CARS.ferrari, kind: 'race', startedAt: ago(1, 18), laps: 14, base: 99_800, weather: 'dry', air: 24, trackTemp: 31, origin: 'companion' },
  { game: 'lmu', track: TRACKS.monza, car: CARS.ferrari, kind: 'practice', startedAt: ago(2, 20), laps: 12, base: 100_900, weather: 'rain', air: 17, trackTemp: 19, origin: 'companion' },
  { game: 'lmu', track: TRACKS.spa, car: CARS.toyota, kind: 'qualifying', startedAt: ago(3, 15), laps: 8, base: 134_500, weather: 'dry', air: 21, trackTemp: 27, origin: 'companion' },
  { game: 'lmu', track: TRACKS.bahrain, car: CARS.ferrari, kind: 'practice', startedAt: ago(5, 9, 30), laps: 10, base: 110_200, weather: null, air: null, trackTemp: null, origin: 'inferred' },
  { game: 'ac', track: TRACKS.monzaAc, car: CARS.porsche, kind: 'practice', startedAt: ago(7, 21), laps: 9, base: 105_600, weather: 'dry', air: 26, trackTemp: null, origin: 'companion' },
  { game: 'ac', track: TRACKS.imola, car: CARS.ferrari488, kind: 'race', startedAt: ago(10, 19), laps: 7, base: 108_300, weather: 'cloudy', air: 15, trackTemp: 17, origin: 'companion' },
];

/** The months before: shorter sessions of a driver who keeps getting faster on Monza, Spa and Imola, with weeks off and weeks of driving every night. */
const history = (rows: Array<[days: number, game: string, track: V1Ref, car: V1Ref, kind: V1Session['kind'], laps: number, base: number]>): Plan[] =>
  rows.map(([days, game, trackRef, carRef, kind, laps, base], i) => ({ game, track: trackRef, car: carRef, kind, startedAt: ago(days, 17 + (i % 5), (i * 7) % 50), laps, base, weather: i % 3 === 0 ? 'dry' : null, air: null, trackTemp: null, origin: 'companion' as const }));
const HISTORY: Plan[] = history([
  [12, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 7, 101_100], [13, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 6, 101_300], [14, 'lmu', TRACKS.spa, CARS.toyota, 'practice', 6, 135_400],
  [16, 'lmu', TRACKS.bahrain, CARS.ferrari, 'qualifying', 5, 111_300], [19, 'ac', TRACKS.imola, CARS.ferrari488, 'practice', 6, 109_100], [21, 'ac', TRACKS.monzaAc, CARS.porsche, 'practice', 5, 107_200],
  [24, 'lmu', TRACKS.monza, CARS.ferrari, 'race', 8, 101_800], [25, 'lmu', TRACKS.spa, CARS.toyota, 'practice', 5, 135_900], [29, 'lmu', TRACKS.bahrain, CARS.ferrari, 'practice', 6, 112_600],
  [33, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 7, 102_300], [38, 'ac', TRACKS.imola, CARS.ferrari488, 'race', 6, 110_400], [41, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 6, 102_900],
  [44, 'lmu', TRACKS.spa, CARS.toyota, 'qualifying', 5, 136_800], [52, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 6, 103_500], [58, 'ac', TRACKS.monzaAc, CARS.porsche, 'practice', 5, 108_100],
  [62, 'lmu', TRACKS.spa, CARS.toyota, 'practice', 5, 138_200], [66, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 6, 104_100], [80, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 5, 105_000],
  [96, 'lmu', TRACKS.bahrain, CARS.ferrari, 'practice', 5, 114_000], [118, 'ac', TRACKS.imola, CARS.ferrari488, 'practice', 6, 112_500], [141, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 6, 106_400],
  [163, 'lmu', TRACKS.spa, CARS.toyota, 'practice', 5, 141_000], [201, 'lmu', TRACKS.monza, CARS.ferrari, 'practice', 6, 107_800],
]);
/** HARNESS_ONE_LAP=1: the one lap an account can have at first, flagged not valid by the game (an out lap): its time is 2:33.7 once the out lap's slowness is in. */
const ONE_LAP: Plan[] = [
  { game: 'lmu', track: TRACKS.interlagos, car: CARS.ginetta, kind: 'practice', startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), laps: 1, base: 131_400, weather: null, air: null, trackTemp: null, origin: 'companion' },
];
const ONE = process.env.HARNESS_ONE_LAP === '1';
const PLANS: Plan[] = ONE ? ONE_LAP : [...RECENT, ...HISTORY];

/** The corners of a track: the example corners stretched to its length. */
const cornersFor = (trackName: string): SynthCorner[] => scaleCorners(exampleCorners(), LENGTH_M[trackName] / 4200);

/**
 * A lap of this track, driven by someone who varies a little: the hairpin's brake point moves, the speed through the last corner
 * and when the throttle comes on after the first one. `skill` (about -1 to 1) is how well the lap went.
 */
function driven(plan: Plan, lap: number, skill: number, rain: boolean, hz = 20): LapFile {
  const corners = cornersFor(plan.track.name).map((corner, index) => {
    if (index === 0) return { ...corner, pickupDist: corner.apexDist + 25 - skill * 8 + (random() - 0.5) * 8 };
    if (index === 1) return { ...corner, brakeDist: corner.brakeDist - 14 * (random() - 0.2) + skill * 6, minSpeedKmh: corner.minSpeedKmh - (rain ? 4 : 0) };
    if (index === 5) return { ...corner, minSpeedKmh: corner.minSpeedKmh + skill * 3 - (rain ? 6 : 0) + (random() - 0.5) * 4 };
    return rain ? { ...corner, minSpeedKmh: Math.min(corner.minSpeedKmh - 3, corner.entrySpeedKmh - 5) } : corner;
  });
  return buildSyntheticLap({ lengthM: LENGTH_M[plan.track.name], corners, hz, trackName: plan.track.name, car: plan.car.name, game: plan.game, lapNumber: lap }).lap;
}

/** The same lap through the pits: slower, as an out or in lap is. The clock and the sectors follow. */
const slowedBy = (lap: LapFile, factor: number): LapFile => ({
  ...lap,
  header: { ...lap.header, lap: { ...lap.header.lap, timeMs: Math.round(lap.header.lap.timeMs * factor) } },
  data: { ...lap.data, t: Float32Array.from(lap.data.t, (value) => value * factor) },
});

/** The state of the fake server, and the lap files, built once. */
let built: Promise<FakeV1State> | null = null;

async function build(): Promise<FakeV1State> {
  const state = fakeV1State({
    devices: [{ id: 'dev-1', name: 'Racing PC', pairedAt: '2026-11-01T00:00:00.000Z', lastSeenAt: new Date().toISOString(), lastLapAt: PLANS[0].startedAt }],
  });
  if (process.env.HARNESS_NO_LAPS === '1') return state;
  let n = 0;
  for (const [index, plan] of PLANS.entries()) {
    const session: V1Session = {
      id: id('00000003', index + 1), game: plan.game, track: plan.track, car: plan.car, kind: plan.kind, origin: plan.origin, startedAt: plan.startedAt,
      endedAt: plan.startedAt, weather: plan.weather, airTempC: plan.air, trackTempC: plan.trackTemp, lapCount: 0, bestLapMs: null,
    };
    state.sessions.push(session);
    let clock = Date.parse(plan.startedAt);
    for (let lap = 1; lap <= plan.laps; lap++) {
      n++;
      const out = lap === 1;
      const into = lap === plan.laps && plan.laps > 6;
      const voided = ONE || lap % 6 === 4;
      // A spread of a second or so, quicker as the session goes on (skill climbs from -1 towards 1); the pit laps are slow.
      const skill = Math.max(-1, Math.min(1, (lap / plan.laps) * 2 - 1 + (random() - 0.5)));
      let file = driven(plan, lap, skill, plan.weather === 'rain', index < RECENT.length && !ONE ? 20 : 8);
      // The clock follows the plan: the plan's base time, a little quicker as the session goes on, a little noise, so progress over the weeks shows.
      file = slowedBy(file, (plan.base - skill * 350 + (random() - 0.5) * 400) / file.header.lap.timeMs);
      if (out) file = slowedBy(file, 1.17);
      else if (into) file = slowedBy(file, 1.07);
      const time = file.header.lap.timeMs;
      const length = LENGTH_M[plan.track.name];
      const at = (fraction: number) => Math.round(1000 * (file.data.t[file.data.dist.findIndex((d) => d >= fraction * length)] ?? 0));
      const s1 = at(0.31);
      const s2 = at(0.7) - s1;
      const sectors = plan.game === 'ac' && plan.track === TRACKS.imola ? null : [s1, s2, time - s1 - s2];
      const lapId = id('00000004', n);
      const startedAt = new Date(clock).toISOString();
      clock += time + 3000;
      state.laps.push({
        id: lapId, game: plan.game, track: plan.track, car: plan.car, sessionId: session.id, lapNumber: lap, timeMs: time, valid: !voided, startedAt, sectorsMs: sectors,
        topSpeedKmh: Math.round(3.6 * Math.max(...file.data.speed)), fuelUsedL: null, inLap: into ? true : null, outLap: out ? true : null, sampleCount: file.header.sampleCount, sizeBytes: 180_000, reduced: false,
        formatVersion: 2, createdAt: new Date(clock).toISOString(), deviceName: 'Racing PC',
      } satisfies V1Lap);
      state.files.set(lapId, await gzipLap({
        ...file,
        header: {
          ...file.header, lap: { number: lap, timeMs: time, valid: !voided, ...(sectors ? { sectorsMs: sectors } : {}), ...(out ? { outLap: true } : {}), ...(into ? { inLap: true } : {}) }, startedAt,
        },
      }));
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
  state.requests.length = 0;
  buildCatalog(state, LENGTH_M);
  return state;
}

/** The layouts "Xpeed Companion sent": a road along the path of a clean lap of the track, with edges and the game's ideal line. */
const LAYOUT_TRACKS = [{ id: 'harness-layout-monza', name: 'Monza' }, { id: 'harness-layout-spa', name: 'Spa-Francorchamps' }];
const layouts = new Map<string, Promise<Uint8Array>>();

function layoutBytes(spec: { id: string; name: string }): Promise<Uint8Array> {
  let found = layouts.get(spec.id);
  if (!found) {
    const lap = buildSyntheticLap({ lengthM: LENGTH_M[spec.name], corners: cornersFor(spec.name), hz: 5, game: 'lmu' }).lap;
    const points = Array.from(lap.data.x, (x, i) => [x, lap.data.z[i]] as [number, number]);
    found = gzipBytes(packLayout(makeLayout({ game: 'lmu', name: spec.name, points, width: 7, closed: false, ideal: true, idealShift: 0.6 })));
    layouts.set(spec.id, found);
  }
  return found;
}

/** Answers `/api/sim/tracks` (the account's layouts) and `/api/sim/tracks/<id>/file`. */
export async function answerLayouts(method: string, path: string): Promise<HarnessAnswer | null> {
  if (process.env.HARNESS_NO_LAPS === '1') return path === '/tracks' && method === 'GET' ? { status: 200, json: { tracks: [] } } : null;
  if (path === '/tracks' && method === 'GET') {
    const tracks = await Promise.all(LAYOUT_TRACKS.map(async (spec) => ({
      id: spec.id, game: 'lmu', trackName: spec.name, variant: null, title: null, lengthM: LENGTH_M[spec.name], size: (await layoutBytes(spec)).length, updatedAt: '2026-11-01T00:00:00.000Z',
    })));
    return { status: 200, json: { tracks } };
  }
  const file = /^\/tracks\/([^/]+)\/file$/.exec(path);
  const spec = file && LAYOUT_TRACKS.find((entry) => entry.id === decodeURIComponent(file[1]));
  return spec && method === 'GET' ? { status: 200, bytes: await layoutBytes(spec) } : null;
}

export interface HarnessAnswer { status: number; json?: unknown; bytes?: Uint8Array }

let down = process.env.HARNESS_API_DOWN === '1';

let social: FakeSocialState | null = null;

/** Answers one call of the API (the read side and the social side, docs/platform/API-V1.md): `path` is what follows `/api/sim/v1`. */
export async function answerV1(method: string, path: string, params: Record<string, string>, body?: unknown): Promise<HarnessAnswer> {
  if (path === '/__fail') {
    down = params.on === '1';
    return { status: 200, json: { down } };
  }
  built ??= build();
  const state = await built;
  state.failing = down ? { status: 503, error: 'unavailable', retryable: true } : null;
  social ??= buildSocial(state);
  social.failing = state.failing;
  const answer = handleSocial(social, method, path, params, body);
  state.requests.length = 0; // nobody reads them here
  social.requests.length = 0;
  return answer;
}

/** Answers the public share endpoint (`/api/sim/public/share/<token>`): no sign-in. Try /s/demo-lap, /s/demo-session and /s/demo-anon. */
export async function answerPublic(path: string): Promise<HarnessAnswer> {
  built ??= build();
  const state = await built;
  social ??= buildSocial(state);
  social.failing = down ? { status: 503, error: 'unavailable', retryable: true } : null;
  return handlePublic(social, path);
}
