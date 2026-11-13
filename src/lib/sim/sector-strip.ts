import type { LapFile } from '@/lib/sim/lap-file';
import { sectorLapFrom, sectorStandings, summarizeSectors, timeLeftOnTable, type SectorStatus } from '@/lib/sim/sectors';

/**
 * The sector strip of the Compare screen: both laps' sector times side by side with the usual colours, the time each lap left on
 * the table in each sector, and the theoretical best of the two laps (the best sectors put together). Computed from the sector
 * times in the two lap headers; no samples are read. Null when the two laps cannot be put side by side (no sectors, a different
 * number of them, or both laps are voided or pit laps).
 */

export type StripTone = 'purple' | 'yellow' | 'none';

export interface StripSector {
  /** 1-based. */
  sector: number;
  lapMs: number | null;
  referenceMs: number | null;
  /** Purple: the best of the two in that sector. Yellow: slower. None: the lap cannot be judged (voided, a pit lap). */
  lapTone: StripTone;
  referenceTone: StripTone;
  /** Lap minus reference, ms (+ the lap is slower); null when either time is missing. */
  deltaMs: number | null;
  /** What each lap left on the table in this sector: its time minus the best of the two. */
  lapLeftMs: number | null;
  referenceLeftMs: number | null;
}

export interface SectorStrip {
  sectors: StripSector[];
  /** The best sectors of the two laps added up. */
  theoreticalBestMs: number;
  /** Total each lap left on the table (null for a lap that is not counted). */
  lapLeftMs: number | null;
  referenceLeftMs: number | null;
  /** The faster of the two laps minus the theoretical best: what perfect sectors would take off. */
  potentialGainMs: number | null;
}

const toneOf = (status: SectorStatus | undefined): StripTone => (status === undefined ? 'none' : status === 'best-of-set' ? 'purple' : 'yellow');

/** A sector time of a lap, when the lap has the number of sectors the strip has (a lap the game voided still shows its times). */
const timeOf = (sectors: readonly number[] | null | undefined, i: number, count: number | null): number | null =>
  sectors && sectors.length === count && sectors[i] > 0 ? sectors[i] : null;

export function sectorStrip(lap: LapFile, reference: LapFile): SectorStrip | null {
  const a = sectorLapFrom(lap, 'lap');
  const b = sectorLapFrom(reference, 'reference');
  // Both laps need a list of sectors, the same number of them: a strip with one side empty says nothing.
  if (!a.sectorsMs?.length || a.sectorsMs.length !== b.sectorsMs?.length) return null;
  const summary = summarizeSectors([a, b]);
  if (summary.sectorCount === null) return null;
  const standingsA = sectorStandings(a, summary);
  const standingsB = sectorStandings(b, summary);
  const leftA = timeLeftOnTable(a, summary);
  const leftB = timeLeftOnTable(b, summary);
  const sectors: StripSector[] = summary.bests.map((_, i) => {
    const lapMs = timeOf(a.sectorsMs, i, summary.sectorCount);
    const referenceMs = timeOf(b.sectorsMs, i, summary.sectorCount);
    return {
      sector: i + 1,
      lapMs,
      referenceMs,
      lapTone: toneOf(standingsA?.[i].status),
      referenceTone: toneOf(standingsB?.[i].status),
      deltaMs: lapMs !== null && referenceMs !== null ? lapMs - referenceMs : null,
      lapLeftMs: leftA ? leftA.perSectorMs[i] : null,
      referenceLeftMs: leftB ? leftB.perSectorMs[i] : null,
    };
  });
  return {
    sectors,
    theoreticalBestMs: summary.theoreticalBestMs ?? 0,
    lapLeftMs: leftA?.totalMs ?? null,
    referenceLeftMs: leftB?.totalMs ?? null,
    potentialGainMs: summary.potentialGainMs,
  };
}
