import { compareCorners, type CornerComparison } from '@/lib/sim/corner-compare';
import { lapInsights, sessionInsights, type Insight, type SessionInsights } from '@/lib/sim/insights';
import type { LapFile } from '@/lib/sim/lap-file';

/**
 * The heavy part of the lap screens, in one place that runs the same on the page or in a Web Worker: a lap against a
 * reference (corner by corner, with the ranked findings), and a set of laps of one session. Pure functions over lap files; the
 * worker (`lap-study.worker.ts`) only calls `handleStudyRequest`, so what the worker returns is what the page would compute.
 */

export interface LapStudy {
  comparison: CornerComparison;
  insights: Insight[];
}

export const compareStudy = (study: LapFile, reference: LapFile): LapStudy => ({
  comparison: compareCorners(study, reference),
  insights: lapInsights(study, reference),
});

/** The channels the analysis reads. A lap file carries more; only these cross to the worker. */
const NEEDED = ['t', 'dist', 'speed', 'gear', 'throttle', 'brake', 'steer', 'x', 'z', 'g_long'] as const;

/** The same lap with only the channels the analysis needs (the arrays are shared, not copied). */
export function slimLap(lap: LapFile): LapFile {
  const data: Record<string, Float32Array> = {};
  for (const id of NEEDED) if (lap.data[id]) data[id] = lap.data[id];
  return { ...lap, data };
}

export type StudyRequest =
  | { id: number; kind: 'compare'; study: LapFile; reference: LapFile }
  | { id: number; kind: 'session'; laps: LapFile[] };

export type StudyResponse =
  | { id: number; ok: true; kind: 'compare'; result: LapStudy }
  | { id: number; ok: true; kind: 'session'; result: SessionInsights }
  | { id: number; ok: false; error: string };

/** What the worker does with one message. Never throws: a failure is an answer. */
export function handleStudyRequest(request: StudyRequest): StudyResponse {
  try {
    if (request.kind === 'compare') return { id: request.id, ok: true, kind: 'compare', result: compareStudy(request.study, request.reference) };
    return { id: request.id, ok: true, kind: 'session', result: sessionInsights(request.laps) };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
