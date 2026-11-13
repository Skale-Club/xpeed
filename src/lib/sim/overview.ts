import type { LapEntry } from '@/lib/sim/account-laps';

/** What the Overview and Game cars screens show, worked out from lap summaries only (no lap file is opened). */

const isTimed = (lap: LapEntry) => lap.summary.valid && lap.summary.timeMs > 0;
const startedMs = (lap: LapEntry) => {
  const ms = Date.parse(lap.summary.startedAt);
  return Number.isFinite(ms) ? ms : 0;
};
const quicker = (a: LapEntry | null, b: LapEntry) => (a === null || b.summary.timeMs < a.summary.timeMs ? b : a);

/** The quickest valid lap of each game + track + car, the ones driven most recently first. */
export function bestLaps(laps: readonly LapEntry[], limit = 8): LapEntry[] {
  const best = new Map<string, LapEntry>();
  for (const lap of laps) {
    if (!isTimed(lap)) continue;
    const key = [lap.summary.game, lap.summary.trackName, lap.summary.carName].join('|');
    best.set(key, quicker(best.get(key) ?? null, lap));
  }
  return [...best.values()].sort((a, b) => startedMs(b) - startedMs(a)).slice(0, limit);
}

export interface GamePlayed {
  game: string;
  laps: number;
}

/** The games the laps were driven in, the most laps first. */
export function gamesPlayed(laps: readonly LapEntry[]): GamePlayed[] {
  const counts = new Map<string, number>();
  for (const lap of laps) counts.set(lap.summary.game, (counts.get(lap.summary.game) ?? 0) + 1);
  return [...counts].map(([game, count]) => ({ game, laps: count })).sort((a, b) => b.laps - a.laps || a.game.localeCompare(b.game));
}

export interface CarTrackStat {
  trackName: string;
  laps: number;
  /** The quickest valid lap on this track, if there is one. */
  best: LapEntry | null;
}

export interface CarStat {
  game: string;
  carName: string;
  laps: number;
  tracks: CarTrackStat[];
  /** Epoch ms of the start of the last lap driven in it. */
  lastDrivenAt: number;
}

export interface GameCars {
  game: string;
  cars: CarStat[];
}

/** Every car driven, by game; in each game the car driven last comes first. */
export function carsByGame(laps: readonly LapEntry[]): GameCars[] {
  const cars = new Map<string, CarStat>();
  for (const lap of laps) {
    const key = `${lap.summary.game}|${lap.summary.carName}`;
    let car = cars.get(key);
    if (!car) {
      car = { game: lap.summary.game, carName: lap.summary.carName, laps: 0, tracks: [], lastDrivenAt: 0 };
      cars.set(key, car);
    }
    car.laps++;
    car.lastDrivenAt = Math.max(car.lastDrivenAt, startedMs(lap));
    let track = car.tracks.find((entry) => entry.trackName === lap.summary.trackName);
    if (!track) {
      track = { trackName: lap.summary.trackName, laps: 0, best: null };
      car.tracks.push(track);
    }
    track.laps++;
    if (isTimed(lap)) track.best = quicker(track.best, lap);
  }
  const byGame = new Map<string, CarStat[]>();
  for (const car of cars.values()) {
    car.tracks.sort((a, b) => a.trackName.localeCompare(b.trackName));
    byGame.set(car.game, [...(byGame.get(car.game) ?? []), car]);
  }
  return [...byGame]
    .map(([game, list]) => ({ game, cars: list.sort((a, b) => b.lastDrivenAt - a.lastDrivenAt || a.carName.localeCompare(b.carName)) }))
    .sort((a, b) => a.game.localeCompare(b.game));
}
