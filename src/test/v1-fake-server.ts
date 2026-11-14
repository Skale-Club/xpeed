import type { StatsRange, V1CarDetail, V1CarItem, V1Improvement, V1Lap, V1Overview, V1Pb, V1Ref, V1Session, V1SessionInsights, V1SpreadSession, V1Stats, V1StatsDay, V1StatsPair, V1StatsTotals, V1TrackDetail, V1TrackItem } from '@/lib/sim/v1-client';

// A fake of the racing data API (docs/platform/API-V1.md) for tests and the screen harness: the same paths, filters, cursor paging,
// error shape and delete behaviour (a deleted lap leaves its session's counters, its personal best and the overview consistent).

let counter = 0;
const uuid = () => {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

export const ref = (name: string, id = uuid()): V1Ref => ({ id, name });

export function v1Lap(extra: Partial<V1Lap> = {}): V1Lap {
  const n = extra.lapNumber ?? ++counter;
  return {
    id: uuid(), game: 'lmu', track: ref('Monza'), car: ref('Ferrari 499P'), sessionId: null, lapNumber: n, timeMs: 100_000 + n, valid: true,
    startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: null, topSpeedKmh: null, fuelUsedL: null, inLap: null, outLap: null, sampleCount: 2000,
    sizeBytes: 100_000, reduced: false, formatVersion: 2, createdAt: '2026-11-10T12:05:00.000Z', deviceName: 'Racing PC', ...extra,
  };
}

export function v1Session(extra: Partial<V1Session> = {}): V1Session {
  return {
    id: uuid(), game: 'lmu', track: ref('Monza'), car: ref('Ferrari 499P'), kind: 'practice', origin: 'companion',
    startedAt: '2026-11-10T12:00:00.000Z', endedAt: '2026-11-10T12:30:00.000Z', weather: null, airTempC: null, trackTempC: null,
    lapCount: 0, bestLapMs: null, ...extra,
  };
}

export interface FakeV1State {
  laps: V1Lap[];
  sessions: V1Session[];
  tracks: V1TrackItem[];
  cars: V1CarItem[];
  devices: V1Overview['companion']['devices'];
  /** Lap files by lap id (gzip bytes), for `GET /laps/<id>/file`. */
  files: Map<string, Uint8Array>;
  /** What `GET /sessions/<id>/insights` answers, by session id; a session not in it is a 404 (a server that predates the endpoint). */
  insights: Map<string, V1SessionInsights>;
  /** Every call the server answered, in order. */
  requests: Array<{ method: string; path: string; params: Record<string, string> }>;
  /** Makes every call fail with this status and error (an outage: 503 unavailable, retryable). */
  failing: { status: number; error: string; retryable: boolean } | null;
  /** With `failing` set: only the paths that start with this fail (`/stats` while the rest answers); every path when null. */
  failingPath: string | null;
  /** A pause before answering (ms), to look at loading states. */
  delayMs: number;
  /** The moment the dashboard counts back from (ISO); the real clock when null. Tests freeze it so the days they build stay in range. */
  now: string | null;
}

export function fakeV1State(partial: Partial<FakeV1State> = {}): FakeV1State {
  return { laps: [], sessions: [], tracks: [], cars: [], devices: [], files: new Map(), insights: new Map(), requests: [], failing: null, failingPath: null, delayMs: 0, now: null, ...partial };
}

/** The track and car catalogs the person has driven, worked out from the laps in `state` (as the server keeps them), most recently driven first. */
export function buildCatalog(state: FakeV1State, lengths: Record<string, number> = {}): void {
  const groups = <T extends V1Ref>(refOf: (lap: V1Lap) => T | null) => {
    const map = new Map<string, { ref: T; laps: V1Lap[] }>();
    for (const lap of state.laps) {
      const ref = refOf(lap);
      if (ref) map.set(ref.id, { ref, laps: [...(map.get(ref.id)?.laps ?? []), lap] });
    }
    return [...map.values()].sort((p, q) => Date.parse(lastDriven(q.laps)!) - Date.parse(lastDriven(p.laps)!));
  };
  const counts = (laps: V1Lap[]) => ({
    lapCount: laps.length, validLapCount: laps.filter((lap) => lap.valid).length, sessionCount: new Set(laps.map((lap) => lap.sessionId)).size,
    bestLapMs: fastest(laps)?.timeMs ?? null, lastDrivenAt: lastDriven(laps)!,
  });
  state.tracks = groups((lap) => lap.track).map(({ ref, laps }) => ({
    id: ref.id, game: laps[0].game, name: ref.name, lengthM: lengths[ref.name] ?? null, carCount: new Set(laps.map((lap) => lap.car?.id)).size, ...counts(laps),
  }));
  state.cars = groups((lap) => lap.car).map(({ ref, laps }) => ({
    id: ref.id, game: laps[0].game, name: ref.name, brand: null, class: null, trackCount: new Set(laps.map((lap) => lap.track?.id)).size, ...counts(laps),
  }));
}

export interface FakeResponse { status: number; json?: unknown; bytes?: Uint8Array }

const fail = (status: number, error: string, retryable = false): FakeResponse => ({ status, json: { error, retryable } });
const encode = (offset: number) => `o${offset}`;
const decode = (cursor: string | undefined) => (cursor === undefined ? 0 : /^o\d+$/.test(cursor) ? Number(cursor.slice(1)) : -1);

function page<T>(items: T[], params: Record<string, string>, list: string): FakeResponse {
  const limitRaw = params.limit === undefined ? 50 : Number(params.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) return fail(400, 'invalid_limit');
  const limit = Math.min(limitRaw, 100);
  const start = decode(params.cursor);
  if (start < 0) return fail(400, 'invalid_cursor');
  const next = start + limit;
  return { status: 200, json: { [list]: items.slice(start, start + limit), nextCursor: next < items.length ? encode(next) : null } };
}

export const personalBests = (laps: readonly V1Lap[]): V1Pb[] => {
  const best = new Map<string, V1Lap>();
  for (const lap of laps) {
    if (!lap.valid || lap.timeMs <= 0 || !lap.track || !lap.car) continue;
    const key = `${lap.game}|${lap.track.id}|${lap.car.id}`;
    const held = best.get(key);
    if (!held || lap.timeMs < held.timeMs) best.set(key, lap);
  }
  return [...best.values()]
    .map((lap): V1Pb => {
      // The best valid lap driven before this one, when it was slower (what this best replaced).
      const earlier = laps.filter((other) => other.valid && other.timeMs > 0 && other.track?.id === lap.track!.id && other.car?.id === lap.car!.id && other.startedAt < lap.startedAt);
      const previous = earlier.length > 0 ? Math.min(...earlier.map((other) => other.timeMs)) : null;
      const replaced = previous !== null && previous > lap.timeMs ? previous : null;
      return { game: lap.game, track: lap.track!, car: lap.car!, bestMs: lap.timeMs, lapId: lap.id, achievedAt: lap.startedAt, previousBestMs: replaced, improvedByMs: replaced === null ? null : replaced - lap.timeMs };
    })
    .sort((p, q) => Date.parse(q.achievedAt) - Date.parse(p.achievedAt));
};

/** The session's counters worked out again from the laps that remain (a session with no laps is removed). */
function refresh(state: FakeV1State) {
  state.sessions = state.sessions
    .map((session) => {
      const laps = state.laps.filter((lap) => lap.sessionId === session.id);
      const valid = laps.filter((lap) => lap.valid && lap.timeMs > 0);
      return { ...session, lapCount: laps.length, bestLapMs: valid.length ? Math.min(...valid.map((lap) => lap.timeMs)) : null };
    })
    .filter((session) => session.lapCount > 0);
}

const day = (lap: V1Lap) => lap.startedAt.slice(0, 10);
const fastest = (laps: V1Lap[]) => laps.filter((lap) => lap.valid && lap.timeMs > 0).sort((p, q) => p.timeMs - q.timeMs)[0] ?? null;
const lastDriven = (laps: V1Lap[]) => laps.map((lap) => lap.startedAt).sort().at(-1) ?? null;

/** The fastest time in each sector over the valid laps that have them (and the lap that set it), as `bestSectorsMs` and `sectorLapIds` of a personal best; null with none. */
function bestSectors(laps: V1Lap[]): { bestSectorsMs: number[] | null; sectorLapIds: string[] | null } {
  const withSectors = laps.filter((lap) => lap.valid && lap.timeMs > 0 && lap.sectorsMs && lap.sectorsMs.length > 0);
  if (withSectors.length === 0) return { bestSectorsMs: null, sectorLapIds: null };
  const count = withSectors[0].sectorsMs!.length;
  const same = withSectors.filter((lap) => lap.sectorsMs!.length === count);
  const winners = Array.from({ length: count }, (_, i) => same.reduce((top, lap) => (lap.sectorsMs![i] < top.sectorsMs![i] ? lap : top)));
  return { bestSectorsMs: winners.map((lap, i) => lap.sectorsMs![i]), sectorLapIds: winners.map((lap) => lap.id) };
}

/** What `GET /tracks/<id>` says: the totals, the best valid lap of each day, laps per day and the best lap of each car. */
export function trackDetail(state: FakeV1State, id: string): V1TrackDetail | null {
  const item = state.tracks.find((track) => track.id === id);
  if (!item) return null;
  const laps = state.laps.filter((lap) => lap.track?.id === id);
  const days = [...new Set(laps.map(day))].sort();
  const cars = new Map<string, V1Lap[]>();
  for (const lap of laps) if (lap.car) cars.set(lap.car.id, [...(cars.get(lap.car.id) ?? []), lap]);
  return {
    track: { id: item.id, game: item.game, name: item.name, lengthM: item.lengthM, ...(item.hasLayout === undefined ? {} : { hasLayout: item.hasLayout, layoutId: item.layoutId ?? null }) },
    totals: {
      lapCount: laps.length, validLapCount: laps.filter((lap) => lap.valid).length, sessionCount: new Set(laps.map((lap) => lap.sessionId)).size,
      carCount: cars.size, bestLapMs: fastest(laps)?.timeMs ?? null, lastDrivenAt: lastDriven(laps),
    },
    progress: {
      bestPerDay: days.flatMap((d) => {
        const best = fastest(laps.filter((lap) => day(lap) === d));
        return best && best.car ? [{ day: d, bestMs: best.timeMs, lapId: best.id, car: best.car }] : [];
      }),
      lapsPerDay: days.map((d) => {
        const ofDay = laps.filter((lap) => day(lap) === d);
        return { day: d, laps: ofDay.length, validLaps: ofDay.filter((lap) => lap.valid).length };
      }),
    },
    bestPerCar: [...cars.values()]
      .map((ofCar) => {
        const best = fastest(ofCar);
        const car = state.cars.find((entry) => entry.id === ofCar[0].car!.id);
        return { car: { id: ofCar[0].car!.id, name: ofCar[0].car!.name, class: car?.class ?? null }, lapCount: ofCar.length, validLapCount: ofCar.filter((lap) => lap.valid).length, bestMs: best?.timeMs ?? null, lapId: best?.id ?? null, achievedAt: best?.startedAt ?? null, ...bestSectors(ofCar) };
      })
      .sort((p, q) => (p.bestMs ?? Infinity) - (q.bestMs ?? Infinity)),
  };
}

/** What `GET /cars/<id>` says: the totals, laps per day and the best valid lap on each track. */
export function carDetail(state: FakeV1State, id: string): V1CarDetail | null {
  const item = state.cars.find((car) => car.id === id);
  if (!item) return null;
  const laps = state.laps.filter((lap) => lap.car?.id === id);
  const days = [...new Set(laps.map(day))].sort();
  const tracks = new Map<string, V1Lap[]>();
  for (const lap of laps) if (lap.track) tracks.set(lap.track.id, [...(tracks.get(lap.track.id) ?? []), lap]);
  return {
    car: { id: item.id, game: item.game, name: item.name, brand: item.brand, class: item.class },
    totals: {
      lapCount: laps.length, validLapCount: laps.filter((lap) => lap.valid).length, sessionCount: new Set(laps.map((lap) => lap.sessionId)).size,
      trackCount: tracks.size, bestLapMs: fastest(laps)?.timeMs ?? null, lastDrivenAt: lastDriven(laps),
    },
    progress: {
      bestPerDay: days.flatMap((d) =>
        [...tracks.values()].flatMap((ofTrack) => {
          const best = fastest(ofTrack.filter((lap) => day(lap) === d));
          return best && best.track ? [{ day: d, bestMs: best.timeMs, lapId: best.id, track: best.track }] : [];
        })),
      lapsPerDay: days.map((d) => {
        const ofDay = laps.filter((lap) => day(lap) === d);
        return { day: d, laps: ofDay.length, validLaps: ofDay.filter((lap) => lap.valid).length };
      }),
    },
    bestPerTrack: [...tracks.values()]
      .map((ofTrack) => {
        const best = fastest(ofTrack);
        return { track: ofTrack[0].track!, lapCount: ofTrack.length, validLapCount: ofTrack.filter((lap) => lap.valid).length, bestMs: best?.timeMs ?? null, lapId: best?.id ?? null, achievedAt: best?.startedAt ?? null };
      })
      .sort((p, q) => p.track.name.localeCompare(q.track.name)),
  };
}

// ---------------------------------------------------------------------------------------------------------------- the dashboard

const DAY_MS = 86_400_000;
const utcDay = (iso: string) => iso.slice(0, 10);
const dayFrom = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const zeroTotals = (): V1StatsTotals => ({ laps: 0, validLaps: 0, sessions: 0, timeMs: 0, distanceM: 0, personalBests: 0, tracks: 0, cars: 0, games: 0 });

/**
 * What `GET /stats?range=` says, worked out from the laps in `state` the way the server's database function does (api/sim/_stats.ts,
 * supabase/migrations/20261113194500_sim_stats.sql): UTC days ending today, the period of the same length before it, personal-best
 * improvements against the running best of each track and car, the 4 most driven pairs, the breakdown and the spread of the latest sessions.
 */
export function computeStats(state: FakeV1State, range: StatsRange, now: Date = new Date()): V1Stats {
  const to = Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS;
  const time = (lap: V1Lap) => Date.parse(lap.startedAt);
  const lapsAll = [...state.laps].sort((p, q) => time(p) - time(q) || p.id.localeCompare(q.id));
  const length = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: 0 }[range] * DAY_MS;
  const first = lapsAll.find((lap) => time(lap) < to);
  const from = range === 'all' ? (first ? Math.floor(time(first) / DAY_MS) * DAY_MS : to - DAY_MS) : to - length;
  const prevFrom = range === 'all' ? null : from - length;
  const heatFrom = range === '7d' || range === '30d' ? null : to - 365 * DAY_MS;
  const inWindow = (lap: V1Lap, start: number, end: number) => time(lap) >= start && time(lap) < end;
  const lengthOf = (lap: V1Lap) => state.tracks.find((track) => track.id === lap.track?.id)?.lengthM ?? 0;
  const ids = (laps: V1Lap[], pick: (lap: V1Lap) => string | null | undefined) => new Set(laps.map(pick).filter(Boolean)).size;
  const isValid = (lap: V1Lap) => lap.valid && lap.timeMs > 0;
  const distance = (laps: V1Lap[]) => Math.round(laps.filter((lap) => lap.timeMs > 0).reduce((total, lap) => total + lengthOf(lap), 0));

  // Personal-best improvements over the whole history: a valid lap that beats the running best of its track and car.
  const running = new Map<string, number>();
  const improvementsAll: Array<V1Improvement & { at: number }> = [];
  for (const lap of lapsAll) {
    if (!isValid(lap) || !lap.track || !lap.car || time(lap) >= to) continue;
    const key = `${lap.track.id}|${lap.car.id}`;
    const before = running.get(key) ?? null;
    if (before === null || lap.timeMs < before) {
      improvementsAll.push({
        lapId: lap.id, trackId: lap.track.id, trackName: lap.track.name, carId: lap.car.id, carName: lap.car.name, game: lap.game, timeMs: lap.timeMs,
        previousBestMs: before, savedMs: before === null ? null : before - lap.timeMs, achievedAt: lap.startedAt, at: time(lap),
      });
      running.set(key, lap.timeMs);
    }
  }
  const improvementsIn = (start: number, end: number) => improvementsAll.filter((item) => item.at >= start && item.at < end);

  const totalsOf = (laps: V1Lap[], start: number, end: number): V1StatsTotals => ({
    laps: laps.length,
    validLaps: laps.filter(isValid).length,
    sessions: ids(laps, (lap) => lap.sessionId),
    timeMs: laps.reduce((total, lap) => total + Math.max(0, lap.timeMs), 0),
    distanceM: distance(laps),
    personalBests: improvementsIn(start, end).length,
    tracks: ids(laps, (lap) => lap.track?.id),
    cars: ids(laps, (lap) => lap.car?.id),
    games: ids(laps, (lap) => lap.game),
  });
  const current = lapsAll.filter((lap) => inWindow(lap, from, to));
  const previousLaps = prevFrom === null ? [] : lapsAll.filter((lap) => inWindow(lap, prevFrom, from));

  const days = new Map<string, V1Lap[]>();
  for (const lap of current) days.set(utcDay(lap.startedAt), [...(days.get(utcDay(lap.startedAt)) ?? []), lap]);
  const perDay: V1StatsDay[] = [...days.entries()].sort(([p], [q]) => p.localeCompare(q)).map(([day, laps]) => ({
    day, laps: laps.length, validLaps: laps.filter(isValid).length, timeMs: laps.reduce((total, lap) => total + Math.max(0, lap.timeMs), 0), distanceM: distance(laps),
    sessions: ids(laps, (lap) => lap.sessionId), personalBests: improvementsIn(from, to).filter((item) => utcDay(item.achievedAt) === day).length,
    tracks: ids(laps, (lap) => lap.track?.id), cars: ids(laps, (lap) => lap.car?.id),
  }));

  // Streaks over the whole history: the current one ends today or yesterday.
  const everyDay = [...new Set(lapsAll.filter((lap) => time(lap) < to).map((lap) => utcDay(lap.startedAt)))].sort();
  let best = 0;
  let run = 0;
  let currentRun = 0;
  everyDay.forEach((day, i) => {
    run = i > 0 && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${everyDay[i - 1]}T00:00:00Z`) === DAY_MS ? run + 1 : 1;
    best = Math.max(best, run);
    if (Date.parse(`${day}T00:00:00Z`) >= to - 2 * DAY_MS) currentRun = run;
  });
  const bestDay = perDay.reduce<{ day: string; laps: number } | null>((top, entry) => (!top || entry.laps > top.laps || (entry.laps === top.laps && entry.day > top.day) ? { day: entry.day, laps: entry.laps } : top), null);

  const pairLaps = new Map<string, V1Lap[]>();
  for (const lap of current) if (lap.track && lap.car) pairLaps.set(`${lap.track.id}|${lap.car.id}`, [...(pairLaps.get(`${lap.track.id}|${lap.car.id}`) ?? []), lap]);
  const pairs: V1StatsPair[] = [...pairLaps.values()]
    .sort((p, q) => q.length - p.length || p[0].track!.name.localeCompare(q[0].track!.name) || p[0].car!.name.localeCompare(q[0].car!.name))
    .slice(0, 4)
    .map((laps) => {
      const byDay = new Map<string, number>();
      for (const lap of laps) if (isValid(lap)) byDay.set(utcDay(lap.startedAt), Math.min(byDay.get(utcDay(lap.startedAt)) ?? Infinity, lap.timeMs));
      return {
        trackId: laps[0].track!.id, trackName: laps[0].track!.name, carId: laps[0].car!.id, carName: laps[0].car!.name, game: laps[0].game, laps: laps.length,
        bestPerDay: [...byDay.entries()].sort(([p], [q]) => p.localeCompare(q)).map(([day, bestMs]) => ({ day, bestMs })),
      };
    });

  const top = (pick: (lap: V1Lap) => V1Ref | null) => {
    const groups = new Map<string, { ref: V1Ref; game: string; laps: number }>();
    for (const lap of current) {
      const ref = pick(lap);
      if (ref) groups.set(ref.id, { ref, game: lap.game, laps: (groups.get(ref.id)?.laps ?? 0) + 1 });
    }
    return [...groups.values()].sort((p, q) => q.laps - p.laps || p.ref.name.localeCompare(q.ref.name)).slice(0, 6).map((entry) => ({ id: entry.ref.id, name: entry.ref.name, game: entry.game, laps: entry.laps }));
  };
  const games = new Map<string, { game: string; laps: number; validLaps: number }>();
  for (const lap of current) {
    const entry = games.get(lap.game) ?? { game: lap.game, laps: 0, validLaps: 0 };
    entry.laps++;
    if (isValid(lap)) entry.validLaps++;
    games.set(lap.game, entry);
  }

  // The person's latest 8 sessions (the range does not matter), oldest first: the spread (sample deviation) of the clean laps, null under 3 of them.
  const sessionStats: Array<V1SpreadSession & { at: number }> = [];
  for (const session of state.sessions) {
    const laps = lapsAll.filter((lap) => lap.sessionId === session.id && time(lap) < to);
    if (laps.length === 0) continue;
    const clean = laps.filter((lap) => isValid(lap) && lap.inLap !== true && lap.outLap !== true);
    let spreadMs: number | null = null;
    if (clean.length >= 3) {
      const mean = clean.reduce((total, lap) => total + lap.timeMs, 0) / clean.length;
      spreadMs = Math.round(Math.sqrt(clean.reduce((total, lap) => total + (lap.timeMs - mean) ** 2, 0) / (clean.length - 1)));
    }
    sessionStats.push({ sessionId: session.id, startedAt: session.startedAt, validLaps: laps.filter(isValid).length, spreadMs, cleanShare: Math.round((clean.length / laps.length) * 1000) / 1000, at: Date.parse(session.startedAt) });
  }
  const consistency: V1SpreadSession[] = sessionStats.sort((p, q) => q.at - p.at).slice(0, 8).reverse().map((entry) => ({ sessionId: entry.sessionId, startedAt: entry.startedAt, validLaps: entry.validLaps, spreadMs: entry.spreadMs, cleanShare: entry.cleanShare }));

  const heat = new Map<string, number>();
  if (heatFrom !== null) for (const lap of lapsAll) if (inWindow(lap, heatFrom, to)) heat.set(utcDay(lap.startedAt), (heat.get(utcDay(lap.startedAt)) ?? 0) + 1);
  return {
    range: { key: range, from: dayFrom(from), to: dayFrom(to - DAY_MS), days: Math.round((to - from) / DAY_MS) },
    totals: totalsOf(current, from, to),
    previous: prevFrom === null ? zeroTotals() : totalsOf(previousLaps, prevFrom, from),
    perDay,
    heatmapDays: heatFrom === null ? null : [...heat.entries()].sort(([p], [q]) => p.localeCompare(q)).map(([day, laps]) => ({ day, laps })),
    streak: { current: currentRun, best, bestDay },
    improvements: improvementsIn(from, to).sort((p, q) => q.at - p.at).slice(0, 10).map((item) => ({
      lapId: item.lapId, trackId: item.trackId, trackName: item.trackName, carId: item.carId, carName: item.carName, game: item.game, timeMs: item.timeMs,
      previousBestMs: item.previousBestMs, savedMs: item.savedMs, achievedAt: item.achievedAt,
    })),
    pairs,
    breakdown: { games: [...games.values()].sort((p, q) => q.laps - p.laps || p.game.localeCompare(q.game)), tracks: top((lap) => lap.track), cars: top((lap) => lap.car) },
    consistency,
  };
}

const byNewest = <T extends { startedAt: string }>(items: T[]) => [...items].sort((p, q) => Date.parse(q.startedAt) - Date.parse(p.startedAt));

/** Answers one call of the API. `path` is what comes after `/api/sim/v1`. */
export function handleV1(state: FakeV1State, method: string, path: string, params: Record<string, string>): FakeResponse {
  state.requests.push({ method, path, params });
  if (state.failing && (state.failingPath === null || path.startsWith(state.failingPath))) return fail(state.failing.status, state.failing.error, state.failing.retryable);

  const parts = path.split('/').filter(Boolean);
  const [head, id, tail] = parts;
  if (method === 'DELETE') {
    if (head !== 'laps' || !id || tail) return fail(404, 'not_found');
    if (!state.laps.some((lap) => lap.id === id)) return fail(404, 'lap_not_found');
    state.laps = state.laps.filter((lap) => lap.id !== id);
    state.files.delete(id);
    refresh(state);
    return { status: 204 };
  }
  if (method !== 'GET') return fail(405, 'method_not_allowed');

  switch (head) {
    case 'laps': {
      if (id && tail === 'file') {
        const bytes = state.files.get(id);
        return bytes ? { status: 200, bytes } : fail(404, 'lap_not_found');
      }
      if (id) {
        const lap = state.laps.find((entry) => entry.id === id);
        return lap ? { status: 200, json: lap } : fail(404, 'lap_not_found');
      }
      const valid = params.valid === undefined ? undefined : ['true', '1'].includes(params.valid);
      const laps = byNewest(state.laps).filter(
        (lap) =>
          (!params.game || lap.game === params.game) && (!params.track || lap.track?.id === params.track) && (!params.car || lap.car?.id === params.car) &&
          (!params.session || lap.sessionId === params.session) && (valid === undefined || lap.valid === valid),
      );
      return page(laps, params, 'laps');
    }
    case 'sessions': {
      if (id && tail === 'insights') {
        const found = state.insights.get(id);
        return found ? { status: 200, json: found } : fail(404, 'not_found');
      }
      if (id) {
        const session = state.sessions.find((entry) => entry.id === id);
        if (!session) return fail(404, 'session_not_found');
        const laps = state.laps.filter((lap) => lap.sessionId === id).sort((p, q) => p.lapNumber - q.lapNumber);
        return { status: 200, json: { session, laps } };
      }
      const sessions = byNewest(state.sessions).filter(
        (entry) => (!params.game || entry.game === params.game) && (!params.track || entry.track.id === params.track) && (!params.car || entry.car.id === params.car),
      );
      return page(sessions, params, 'sessions');
    }
    case 'tracks': {
      if (id) {
        const detail = trackDetail(state, id);
        return detail ? { status: 200, json: detail } : fail(404, 'track_not_found');
      }
      return page(state.tracks.filter((track) => !params.game || track.game === params.game), params, 'tracks');
    }
    case 'cars': {
      if (id) {
        const detail = carDetail(state, id);
        return detail ? { status: 200, json: detail } : fail(404, 'car_not_found');
      }
      return page(state.cars.filter((car) => !params.game || car.game === params.game), params, 'cars');
    }
    case 'pbs': {
      const pbs = personalBests(state.laps).filter(
        (pb) => (!params.game || pb.game === params.game) && (!params.track || pb.track.id === params.track) && (!params.car || pb.car.id === params.car),
      );
      return page(pbs, params, 'pbs');
    }
    case 'stats': {
      const range = params.range ?? '30d';
      if (!['7d', '30d', '90d', '1y', 'all'].includes(range)) return fail(400, 'invalid_range');
      return { status: 200, json: computeStats(state, range as StatsRange, state.now ? new Date(state.now) : new Date()) };
    }
    case 'overview': {
      const games = new Map<string, { game: string; laps: number; validLaps: number; sessions: number; lastDrivenAt: string }>();
      for (const lap of state.laps) {
        const entry = games.get(lap.game) ?? { game: lap.game, laps: 0, validLaps: 0, sessions: 0, lastDrivenAt: lap.startedAt };
        entry.laps++;
        if (lap.valid) entry.validLaps++;
        if (Date.parse(lap.startedAt) > Date.parse(entry.lastDrivenAt)) entry.lastDrivenAt = lap.startedAt;
        games.set(lap.game, entry);
      }
      for (const session of state.sessions) if (games.has(session.game)) games.get(session.game)!.sessions++;
      const lastLap = [...state.laps].sort((p, q) => Date.parse(q.createdAt) - Date.parse(p.createdAt))[0] ?? null;
      const body: V1Overview = {
        latestSessions: byNewest(state.sessions).slice(0, 5),
        latestPersonalBests: personalBests(state.laps).slice(0, 5),
        lapsPerGame: [...games.values()].sort((p, q) => q.laps - p.laps),
        companion: { devices: state.devices, lastLap },
        storage: { lapCount: state.laps.length, usedBytes: state.laps.reduce((sum, lap) => sum + lap.sizeBytes, 0), limitBytes: 20 * 1024 ** 3 },
      };
      return { status: 200, json: body };
    }
    default:
      return fail(404, 'not_found');
  }
}

/** A `fetch` that answers the calls of the API from `state` (anything else is a 404). */
export function fakeV1Fetch(state: FakeV1State) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const prefix = '/api/sim/v1';
    if (!url.pathname.startsWith(prefix)) return new Response(null, { status: 404 });
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const answer = handleV1(state, init?.method ?? 'GET', url.pathname.slice(prefix.length), Object.fromEntries(url.searchParams));
    if (answer.bytes) return new Response(answer.bytes as BodyInit, { status: answer.status });
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status });
  };
}
