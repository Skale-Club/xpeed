import type { LapFile } from '@/lib/sim/lap-file';
import type { V1Lap } from '@/lib/sim/v1-client';

/**
 * What the header and the chips say about a lap file: its track and car, its number and time, and whether the game counted it.
 *
 * `track` and `car` are the names a person reads: the account's (the lap's metadata, named from the catalog), else the title the
 * game gave in the file (lap header v2), else the game's own name. An older Assetto Corsa lap only carries the folder
 * (`ks_laguna_seca`, `ks_porsche_macan`); the account calls it "Laguna Seca" and "Porsche Macan Turbo" (owner, 2026-11-22).
 * `trackKey` and `carKey` are the game's own names, which identify them: compare those, never the names shown, so a lap whose
 * metadata has not arrived yet is not taken for another track or car.
 */
export const describeLap = (lap: LapFile, meta?: Pick<V1Lap, 'track' | 'car'> | null) => {
  const { track, car, lap: info } = lap.header;
  const shown = (account: string | undefined, title: string | undefined, own: string) =>
    [account, title, own].find((name) => typeof name === 'string' && name.trim() !== '')?.trim() ?? own;
  return {
    track: shown(meta?.track?.name, track.title, track.name),
    car: shown(meta?.car?.name, car.title, car.name),
    trackKey: track.name.trim().toLowerCase(),
    carKey: car.name.trim().toLowerCase(),
    number: info.number,
    timeMs: info.timeMs,
    valid: info.valid,
  };
};
