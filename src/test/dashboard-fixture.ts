import type { V1Lap, V1Ref, V1Session } from '@/lib/sim/v1-client';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';

// Racing data for the Overview dashboard tests: laps spread over several weeks (and a period before them), with out and in laps, an invalid lap, several
// tracks, cars and games. The clock of the fake server is frozen at NOW, so "the last 30 days" is always the same laps.

export const NOW = '2026-11-13T12:00:00.000Z';
export const MONZA = ref('Monza');
export const SPA = ref('Spa-Francorchamps');
export const IMOLA = ref('Imola');
export const INTERLAGOS = ref('Interlagos');
export const FERRARI = ref('Ferrari 499P');
export const TOYOTA = ref('Toyota GR010');
export const PORSCHE = ref('Porsche 911 GT3 R');
export const GINETTA = ref('Ginetta G40');
export const LENGTHS: Record<string, number> = { Monza: 5793, 'Spa-Francorchamps': 7004, Imola: 4909, Interlagos: 4309 };

export interface LapFlag { valid?: boolean; inLap?: boolean; outLap?: boolean }

/** A session of laps: `times` are the lap times in ms, `flags[i]` says a lap is invalid or an in or out lap. Laps follow each other 3 minutes apart. */
export function addSession(state: FakeV1State, spec: { game?: string; track: V1Ref; car: V1Ref; startedAt: string; times: number[]; flags?: LapFlag[]; kind?: V1Session['kind'] }): V1Session {
  const game = spec.game ?? 'lmu';
  const session = v1Session({ game, track: spec.track, car: spec.car, kind: spec.kind ?? 'practice', startedAt: spec.startedAt, endedAt: spec.startedAt });
  const laps: V1Lap[] = spec.times.map((timeMs, i) => v1Lap({
    game, track: spec.track, car: spec.car, sessionId: session.id, lapNumber: i + 1, timeMs, valid: spec.flags?.[i]?.valid ?? true,
    inLap: spec.flags?.[i]?.inLap ?? null, outLap: spec.flags?.[i]?.outLap ?? null,
    startedAt: new Date(Date.parse(spec.startedAt) + i * 180_000).toISOString(), createdAt: new Date(Date.parse(spec.startedAt) + i * 180_000 + 60_000).toISOString(),
  }));
  state.laps.push(...laps);
  const valid = laps.filter((lap) => lap.valid).map((lap) => lap.timeMs);
  state.sessions.push({ ...session, lapCount: laps.length, bestLapMs: valid.length ? Math.min(...valid) : null, endedAt: laps[laps.length - 1].startedAt });
  return state.sessions[state.sessions.length - 1];
}

/** A normal account: a month of driving (a session or two a week, improving on Monza), the month before, and a session months ago. */
export function dashboardState(): FakeV1State {
  const state = fakeV1State({
    now: NOW,
    devices: [{ id: 'dev-1', name: 'Racing PC', pairedAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-11-13T11:00:00.000Z', lastLapAt: '2026-11-12T18:20:00.000Z' }],
  });
  addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-11-12T18:00:00.000Z', kind: 'race',
    times: [118_000, 100_400, 100_100, 100_300, 99_900, 99_800, 99_600, 108_000], flags: [{ outLap: true }, {}, { valid: false }, {}, {}, {}, {}, { inLap: true }] });
  addSession(state, { track: IMOLA, car: PORSCHE, game: 'ac', startedAt: '2026-11-11T21:00:00.000Z', times: [108_000, 107_500, 107_600] });
  addSession(state, { track: SPA, car: TOYOTA, startedAt: '2026-11-03T15:00:00.000Z', kind: 'qualifying', times: [135_500, 134_900, 134_600] });
  addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-11-05T19:00:00.000Z', times: [101_500, 101_200, 100_900, 100_700] });
  addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-10-28T20:00:00.000Z', times: [102_500, 102_100, 101_900] });
  // The 30 days before: Monza and Spa, slower.
  addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-10-05T19:00:00.000Z', times: [104_000, 103_500] });
  addSession(state, { track: SPA, car: TOYOTA, startedAt: '2026-09-25T15:00:00.000Z', times: [140_000, 139_000, 138_800] });
  // Months ago.
  addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-05-01T19:00:00.000Z', times: [110_000] });
  buildCatalog(state, LENGTHS);
  state.requests.length = 0;
  return state;
}

/** The account of the owner at the time of the redesign: one lap, flagged not valid by the game (an out lap), today. */
export function oneInvalidLapState(): FakeV1State {
  const state = fakeV1State({
    now: NOW,
    devices: [{ id: 'dev-1', name: 'Racing PC', pairedAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-13T11:00:00.000Z', lastLapAt: '2026-11-13T09:05:00.000Z' }],
  });
  addSession(state, { track: INTERLAGOS, car: GINETTA, startedAt: '2026-11-13T09:00:00.000Z', times: [154_252], flags: [{ valid: false, outLap: true }] });
  buildCatalog(state, LENGTHS);
  state.requests.length = 0;
  return state;
}
