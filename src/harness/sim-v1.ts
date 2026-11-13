// Screen harness only: a fake of the racing data API (docs/platform/API-V1.md) with realistic data, served by vite.harness.config.ts
// at /api/sim/v1/*. Several tracks and cars, 60 laps across six sessions (sectors, an out lap, an in lap and voided laps in each),
// and a real lap file for every lap, so Sessions, the session page and Compare can be clicked through without a server.
//
//   HARNESS_NO_LAPS=1   an account with nothing in it (the empty states)
//   HARNESS_API_DOWN=1  every call fails with 503 (the error state); /api/sim/v1/__fail?on=1 and ?on=0 switch it while the harness runs
import { gzipLap } from '@/lib/sim/lap-file';
import type { V1CarItem, V1Lap, V1Ref, V1Session, V1TrackItem } from '@/lib/sim/v1-client';
import { makeLapFixtures } from '@/test/lap-fixture';
import { fakeV1State, handleV1, type FakeV1State } from '@/test/v1-fake-server';

let seed = 20261113;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = (n: number, name: string): V1Ref => ({ id: id('00000001', n), name });
const car = (n: number, name: string): V1Ref => ({ id: id('00000002', n), name });

const TRACKS = { monza: track(1, 'Monza'), spa: track(2, 'Spa-Francorchamps'), bahrain: track(3, 'Bahrain International Circuit'), imola: track(4, 'Imola') };
const CARS = { ferrari: car(1, 'Ferrari 499P'), toyota: car(2, 'Toyota GR010'), porsche: car(3, 'Porsche 911 GT3 R'), ferrari488: car(4, 'Ferrari 488 GT3') };
/** The lap file of a track is scaled to its length, so laps of the same track compare and laps of different tracks do not. */
const LENGTH_SCALE: Record<string, number> = { Monza: 1.8, 'Spa-Francorchamps': 2.4, 'Bahrain International Circuit': 1.7, Imola: 1.2 };
const LENGTH_M: Record<string, number> = { Monza: 5793, 'Spa-Francorchamps': 7004, 'Bahrain International Circuit': 5412, Imola: 4909 };

interface Plan {
  game: string; track: V1Ref; car: V1Ref; kind: V1Session['kind']; startedAt: string; laps: number; base: number; weather: string | null; air: number | null; trackTemp: number | null;
  origin: V1Session['origin'];
}
const PLANS: Plan[] = [
  { game: 'lmu', track: TRACKS.monza, car: CARS.ferrari, kind: 'race', startedAt: '2026-11-12T18:00:00.000Z', laps: 14, base: 99_800, weather: 'dry', air: 24, trackTemp: 31, origin: 'companion' },
  { game: 'lmu', track: TRACKS.monza, car: CARS.ferrari, kind: 'practice', startedAt: '2026-11-11T20:00:00.000Z', laps: 12, base: 100_900, weather: 'rain', air: 17, trackTemp: 19, origin: 'companion' },
  { game: 'lmu', track: TRACKS.spa, car: CARS.toyota, kind: 'qualifying', startedAt: '2026-11-10T15:00:00.000Z', laps: 8, base: 134_500, weather: 'dry', air: 21, trackTemp: 27, origin: 'companion' },
  { game: 'lmu', track: TRACKS.bahrain, car: CARS.ferrari, kind: 'practice', startedAt: '2026-11-08T09:30:00.000Z', laps: 10, base: 110_200, weather: null, air: null, trackTemp: null, origin: 'inferred' },
  { game: 'ac', track: TRACKS.monza, car: CARS.porsche, kind: 'practice', startedAt: '2026-11-06T21:00:00.000Z', laps: 9, base: 105_600, weather: 'dry', air: 26, trackTemp: null, origin: 'companion' },
  { game: 'ac', track: TRACKS.imola, car: CARS.ferrari488, kind: 'race', startedAt: '2026-11-03T19:00:00.000Z', laps: 7, base: 108_300, weather: 'cloudy', air: 15, trackTemp: 17, origin: 'companion' },
];

/** The state of the fake server, and the lap files, built once. */
let built: Promise<FakeV1State> | null = null;

async function build(): Promise<FakeV1State> {
  const state = fakeV1State({
    devices: [{ id: 'dev-1', name: 'Racing PC', pairedAt: '2026-11-01T00:00:00.000Z', lastSeenAt: new Date().toISOString(), lastLapAt: PLANS[0].startedAt }],
  });
  if (process.env.HARNESS_NO_LAPS === '1') return state;
  const [slow, fast] = makeLapFixtures();
  let n = 0;
  for (const [index, plan] of PLANS.entries()) {
    const session: V1Session = {
      id: id('00000003', index + 1), game: plan.game, track: plan.track, car: plan.car, kind: plan.kind, origin: plan.origin, startedAt: plan.startedAt,
      endedAt: new Date(Date.parse(plan.startedAt) + plan.laps * (plan.base + 8000)).toISOString(), weather: plan.weather, airTempC: plan.air, trackTempC: plan.trackTemp, lapCount: 0, bestLapMs: null,
    };
    state.sessions.push(session);
    let clock = Date.parse(plan.startedAt);
    for (let lap = 1; lap <= plan.laps; lap++) {
      n++;
      const out = lap === 1;
      const into = lap === plan.laps && plan.laps > 6;
      const voided = lap % 6 === 4;
      // A spread of a second or so, quicker as the session goes on; the pit laps are slow.
      const time = Math.round(plan.base + (out ? 17_000 : into ? 9_000 : 0) + random() * 1800 - lap * 22 + (plan.weather === 'rain' ? 4_000 : 0));
      const s1 = Math.round(time * (0.28 + random() * 0.01));
      const s2 = Math.round(time * (0.4 + random() * 0.01));
      const sectors = plan.game === 'ac' && plan.track === TRACKS.imola ? null : [s1, s2, time - s1 - s2];
      const lapId = id('00000004', n);
      const startedAt = new Date(clock).toISOString();
      clock += time + 3000;
      state.laps.push({
        id: lapId, game: plan.game, track: plan.track, car: plan.car, sessionId: session.id, lapNumber: lap, timeMs: time, valid: !voided, startedAt, sectorsMs: sectors,
        topSpeedKmh: 300 + Math.round(random() * 20), fuelUsedL: null, inLap: into ? true : null, outLap: out ? true : null, sampleCount: slow.header.sampleCount, sizeBytes: 180_000, reduced: false,
        formatVersion: 2, createdAt: new Date(clock).toISOString(), deviceName: 'Racing PC',
      } satisfies V1Lap);
      // The lap file: the samples of one of the two fixture laps, with the header of this lap.
      const source = lap % 2 ? slow : fast;
      const scale = LENGTH_SCALE[plan.track.name];
      state.files.set(lapId, await gzipLap({
        ...source,
        header: {
          ...source.header, game: plan.game, track: { name: plan.track.name, lengthM: LENGTH_M[plan.track.name] }, car: { name: plan.car.name },
          lap: { number: lap, timeMs: time, valid: !voided, ...(sectors ? { sectorsMs: sectors } : {}), ...(out ? { outLap: true } : {}), ...(into ? { inLap: true } : {}) }, startedAt,
        },
        data: { ...source.data, dist: source.data.dist.map((d) => d * scale), x: source.data.x.map((v) => v * scale), z: source.data.z.map((v) => v * scale), t: source.data.t.map((t) => (t * time) / 1000 / source.data.t[source.data.t.length - 1]) },
      }));
    }
  }
  // The counters, as the server keeps them.
  for (const session of state.sessions) {
    const laps = state.laps.filter((entry) => entry.sessionId === session.id);
    const valid = laps.filter((entry) => entry.valid);
    session.lapCount = laps.length;
    session.bestLapMs = valid.length ? Math.min(...valid.map((entry) => entry.timeMs)) : null;
  }
  state.requests.length = 0;
  const catalog = <T extends { id: string }>(refOf: (lap: V1Lap) => V1Ref | null, make: (ref: V1Ref, laps: V1Lap[]) => T) =>
    [...new Set(state.laps.map((lap) => refOf(lap)?.id))].flatMap((refId) => {
      const laps = state.laps.filter((lap) => refOf(lap)?.id === refId);
      return laps.length ? [make(refOf(laps[0])!, laps)] : [];
    });
  const best = (laps: V1Lap[]) => {
    const valid = laps.filter((lap) => lap.valid);
    return valid.length ? Math.min(...valid.map((lap) => lap.timeMs)) : null;
  };
  const last = (laps: V1Lap[]) => laps.map((lap) => lap.startedAt).sort().at(-1)!;
  state.tracks = catalog<V1TrackItem>((lap) => lap.track, (ref, laps) => ({
    id: ref.id, game: laps[0].game, name: ref.name, lengthM: LENGTH_M[ref.name] ?? null, lapCount: laps.length, validLapCount: laps.filter((lap) => lap.valid).length,
    sessionCount: new Set(laps.map((lap) => lap.sessionId)).size, carCount: new Set(laps.map((lap) => lap.car?.id)).size, bestLapMs: best(laps), lastDrivenAt: last(laps),
  }));
  state.cars = catalog<V1CarItem>((lap) => lap.car, (ref, laps) => ({
    id: ref.id, game: laps[0].game, name: ref.name, brand: null, class: null, lapCount: laps.length, validLapCount: laps.filter((lap) => lap.valid).length,
    sessionCount: new Set(laps.map((lap) => lap.sessionId)).size, trackCount: new Set(laps.map((lap) => lap.track?.id)).size, bestLapMs: best(laps), lastDrivenAt: last(laps),
  }));
  return state;
}

export interface HarnessAnswer { status: number; json?: unknown; bytes?: Uint8Array }

let down = process.env.HARNESS_API_DOWN === '1';

/** Answers one call of the API: `path` is what follows `/api/sim/v1`. */
export async function answerV1(method: string, path: string, params: Record<string, string>): Promise<HarnessAnswer> {
  if (path === '/__fail') {
    down = params.on === '1';
    return { status: 200, json: { down } };
  }
  built ??= build();
  const state = await built;
  state.failing = down ? { status: 503, error: 'unavailable', retryable: true } : null;
  const answer = handleV1(state, method, path, params);
  state.requests.length = 0; // nobody reads them here
  return answer;
}
