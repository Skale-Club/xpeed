// What the server reads out of a lap file to keep beside its row (the summary columns of sim_laps): sector times,
// top speed, fuel used, in/out lap flags, and the session details the Companion put in the header.
import { type LapFile } from '../../src/lib/sim/lap-file';

export interface LapSummary {
  sectorMs: number[] | null;
  topSpeedKmh: number | null;
  fuelUsedL: number | null;
  inLap: boolean | null;
  outLap: boolean | null;
  formatVersion: number;
  session: { id: string | null; kind: string | null; weather: string | null; airTempC: number | null; trackTempC: number | null };
}

const finite = (value: number) => Number.isFinite(value);

/** The fastest the car went, in km/h (the `speed` channel is m/s), to 0.1; null when the file has no usable speed. */
export function topSpeedKmh(speed: Float32Array | undefined): number | null {
  if (!speed) return null;
  let top = -Infinity;
  for (const value of speed) if (finite(value) && value > top) top = value;
  if (top < 0) return null;
  const kmh = Math.round(top * 3.6 * 10) / 10;
  // The column allows up to 2000 km/h; a bigger number is a bad channel, not a lap to refuse.
  return kmh <= 2000 ? kmh : null;
}

/** Fuel burned over the lap, in litres to 0.001: the first reading minus the last. Null when there is no fuel channel or the tank went up (a refuel). */
export function fuelUsedL(fuel: Float32Array | undefined): number | null {
  if (!fuel) return null;
  let first: number | null = null, last: number | null = null;
  for (const value of fuel) if (finite(value)) { if (first === null) first = value; last = value; }
  if (first === null || last === null) return null;
  const used = Math.round((first - last) * 1000) / 1000;
  return used >= 0 && used <= 1000 ? used : null;
}

export function summarizeLap(lap: LapFile): LapSummary {
  const { header, data } = lap;
  return {
    sectorMs: header.lap.sectorsMs && header.lap.sectorsMs.length > 0 ? header.lap.sectorsMs : null,
    topSpeedKmh: topSpeedKmh(data.speed),
    fuelUsedL: fuelUsedL(data.fuel),
    inLap: header.lap.inLap ?? null,
    outLap: header.lap.outLap ?? null,
    formatVersion: lap.version ?? 1,
    session: {
      id: header.sessionId ?? null,
      kind: header.sessionKind ?? null,
      weather: header.weather ?? null,
      airTempC: header.airTempC ?? null,
      trackTempC: header.trackTempC ?? null,
    },
  };
}
