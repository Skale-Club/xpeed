import type { LapHeader } from './lap-file.ts';
import { evoCoordinateFrame } from './reference-context.ts';

/**
 * Multiplier of (travel.z, -travel.x) that points to the driver's left.
 * AC and iRacing retain their original opposite-handed ground. EVO changed
 * inside 0.8.2, so its recording metadata, never its version alone, decides.
 * Other existing readers retain the project's established camera convention;
 * this does not establish live source accuracy for an unverified reader.
 */
export function planarLeftSign(header: LapHeader): 1 | -1 | null {
  const game = header.game.trim().toLowerCase();
  if (game === 'acevo') {
    const frame = evoCoordinateFrame(header);
    return frame === 'reflected' ? -1 : frame === 'original' ? 1 : null;
  }
  // An opaque future frame must not inherit today's handedness by game name.
  if (header.recorder?.coordinateFrame !== undefined) return null;
  return game === 'ac' || game === 'iracing' ? 1 : -1;
}
