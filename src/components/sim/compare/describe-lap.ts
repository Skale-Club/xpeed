import type { LapFile } from '@/lib/sim/lap-file';

/** What the header and the chips say about a lap file: its track and car, its number and time, and whether the game counted it. */
export const describeLap = (lap: LapFile) => {
  const { track, car, lap: info } = lap.header;
  return { track: track.name, car: car.name, number: info.number, timeMs: info.timeMs, valid: info.valid };
};
