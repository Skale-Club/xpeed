// Which driving aids a lap was driven with, sorted into the class a leaderboard filters by (plans/condition-aware-leaderboards.md,
// phase 3). Worked out once, when the lap arrives, and stored beside it (`sim_laps.aids`, `sim_laps.aid_class`).
//
// The header's `aids` is what the game reported through the Companion, so it is a claim. The file also records, sample by sample, when
// traction control and ABS were acting (`tc_active`, `abs_active`); a lap that says "TC 0" but shows TC acting is contradicting itself.
// That does NOT make the lap implausible (it still ranks on the open board, like every lap before aids existed): its class falls back to
// `unknown`, so it is never on an aid board, and the contradiction goes into the `plausibility` column for the moderators.
import type { LapAids, LapFile } from '../../src/lib/sim/lap-file';
import { PLAUSIBILITY, plausibilityJson, type PlausibilityResult } from './_plausibility';

/** `none`: TC and ABS off and nothing else on. `no_tc_abs`: TC and ABS off, some other aid on. `any`: TC or ABS on. `unknown`: not known. */
export type AidClass = 'none' | 'no_tc_abs' | 'any' | 'unknown';

/** True when an aid the header gives is on. A missing key says nothing, so it is not "on". */
function otherAidOn(aids: LapAids): boolean {
  return (aids.stability !== undefined && aids.stability > 0)
    || aids.autoShift === true || aids.autoClutch === true || aids.autoBlip === true || aids.idealLine === true;
}

/**
 * The class of a header's aids. TC and ABS decide it, because those are what a "no aids" board promises; a missing TC or ABS is
 * unknown, never off. The other aids only tell `none` from `no_tc_abs`, and only those the game gave count.
 */
export function classifyAids(aids: LapAids | undefined): AidClass {
  if (!aids) return 'unknown';
  const { tcMax, absMax } = aids;
  if ((tcMax !== undefined && tcMax > 0) || (absMax !== undefined && absMax > 0)) return 'any';
  if (tcMax === undefined || absMax === undefined) return 'unknown';
  return otherAidOn(aids) ? 'no_tc_abs' : 'none';
}

export interface AidsConsistency {
  /** False when a lap that says an aid was off shows it acting in more than `PLAUSIBILITY.aidActiveSamples` samples. */
  consistent: boolean;
  /** Samples with `tc_active` set, counted only when the header says tcMax is 0; null when that was not claimed or the file has no such channel. */
  tcActiveSamples: number | null;
  absActiveSamples: number | null;
}

/** Samples of a flag channel that are set (the flag is 0 or 1; NaN, a sample the game did not give, is not counted). */
function activeSamples(column: Float32Array | undefined): number | null {
  if (!column) return null;
  let count = 0;
  for (const value of column) if (value >= 0.5) count++;
  return count;
}

/**
 * Checks the claim "TC off" and "ABS off" against the channels. A few stray samples are tolerated (`PLAUSIBILITY.aidActiveSamples`):
 * a game can flicker the flag on a kerb or a bad frame, and one flicker is not a lie about the whole lap. Only a claim of exactly 0 is
 * checked; a lap that says TC was on cannot contradict itself by showing it acting.
 */
export function checkAidsConsistency(lap: LapFile): AidsConsistency {
  const { aids } = lap.header;
  const tc = aids?.tcMax === 0 ? activeSamples(lap.data.tc_active) : null;
  const abs = aids?.absMax === 0 ? activeSamples(lap.data.abs_active) : null;
  const consistent = !((tc ?? 0) > PLAUSIBILITY.aidActiveSamples || (abs ?? 0) > PLAUSIBILITY.aidActiveSamples);
  return { consistent, tcActiveSamples: tc, absActiveSamples: abs };
}

export interface AidsVerdict {
  /** What the board filters read. `unknown` when the header has no aids or the lap contradicts them. */
  aidClass: AidClass;
  /** The header's aids for the row icons: null when there are none or when the lap contradicts them (a contradicted claim is not shown). */
  aids: LapAids | null;
  consistency: AidsConsistency;
}

export function aidsVerdict(lap: LapFile): AidsVerdict {
  const consistency = checkAidsConsistency(lap);
  const claimed = lap.header.aids;
  if (!consistency.consistent) return { aidClass: 'unknown', aids: null, consistency };
  return { aidClass: classifyAids(claimed), aids: claimed ?? null, consistency };
}

/**
 * The `plausibility` column: the checks that failed, as before, plus an `aids` key only when the lap contradicts its own aids (what
 * GET /v1/admin/laps/<id> shows). `plausible` and the failed checks are not touched by it.
 */
export function plausibilityWithAids(result: PlausibilityResult, verdict: AidsVerdict, claimed: LapAids | undefined) {
  const base = plausibilityJson(result);
  if (verdict.consistency.consistent) return base;
  const { tcActiveSamples, absActiveSamples } = verdict.consistency;
  return { ...base, aids: { consistent: false, tcActiveSamples, absActiveSamples, limit: PLAUSIBILITY.aidActiveSamples, claimed: claimed ?? null } };
}
