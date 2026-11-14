import type { V1InsightFinding, V1Lap, V1SessionInsights } from '@/lib/sim/v1-client';

// What `GET /sessions/<id>/insights` answers (docs/platform/API-V1.md, api/sim/_insights.ts), worked out from a session's laps the way the server does, for
// the screen harness and the tests: usable laps are valid, timed and not in or out laps; the averages are over the ones within 7 % of the best; the sector
// figures use the majority sector count; at most two findings, in the order sectorGain, sectorSpread, consistency.

const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const deviation = (values: number[]) => (values.length < 3 ? null : Math.sqrt(values.reduce((total, value) => total + (value - mean(values)) ** 2, 0) / (values.length - 1)));

export function buildInsights(sessionId: string, laps: readonly V1Lap[]): V1SessionInsights {
  const usable = laps.filter((lap) => lap.valid && lap.timeMs > 0 && lap.inLap !== true && lap.outLap !== true);
  const best = usable.reduce<V1Lap | null>((top, lap) => (top === null || lap.timeMs < top.timeMs ? lap : top), null);
  const considered = best ? usable.filter((lap) => lap.timeMs <= best.timeMs * 1.07) : [];
  const stdDev = deviation(considered.map((lap) => lap.timeMs));

  // Sectors: the majority count (the larger on a tie) among the usable laps that have sectors and no sector of 0 ms or less.
  const withSectors = usable.filter((lap) => lap.sectorsMs && lap.sectorsMs.length > 0 && lap.sectorsMs.every((ms) => ms > 0));
  const counts = new Map<number, number>();
  for (const lap of withSectors) counts.set(lap.sectorsMs!.length, (counts.get(lap.sectorsMs!.length) ?? 0) + 1);
  const count = [...counts.entries()].sort((p, q) => q[1] - p[1] || q[0] - p[0])[0]?.[0] ?? 0;
  const ofCount = withSectors.filter((lap) => lap.sectorsMs!.length === count);
  let sectors: V1SessionInsights['summary']['sectors'] = null;
  const findings: V1InsightFinding[] = [];
  if (count > 0 && ofCount.length > 0 && best) {
    const bestMs = Array.from({ length: count }, (_, i) => Math.min(...ofCount.map((lap) => lap.sectorsMs![i])));
    const bestLapIds = bestMs.map((ms, i) => ofCount.find((lap) => lap.sectorsMs![i] === ms)!.id);
    const bestSectors = best.sectorsMs && best.sectorsMs.length === count ? best.sectorsMs : null;
    const gainMs = bestSectors ? bestSectors.map((ms, i) => ms - bestMs[i]) : bestMs.map(() => 0);
    const theoreticalBestMs = bestMs.reduce((total, ms) => total + ms, 0);
    const spreadMs = considered.filter((lap) => lap.sectorsMs?.length === count).length >= 3
      ? bestMs.map((_, i) => Math.round(deviation(considered.filter((lap) => lap.sectorsMs?.length === count).map((lap) => lap.sectorsMs![i]))!))
      : null;
    const widestAt = spreadMs ? spreadMs.indexOf(Math.max(...spreadMs)) : -1;
    sectors = {
      count, bestMs, bestLapIds, gainMs, theoreticalBestMs, theoreticalGainMs: best.timeMs - theoreticalBestMs, spreadMs,
      widest: widestAt >= 0 && spreadMs ? { sector: widestAt + 1, stdDevMs: spreadMs[widestAt] } : null,
    } as unknown as V1SessionInsights['summary']['sectors'];
    const worst = gainMs.indexOf(Math.max(...gainMs));
    if (usable.length >= 3 && gainMs[worst] >= 50) findings.push({ kind: 'sectorGain', sector: worst + 1, gainMs: gainMs[worst], lapId: best.id });
    if (usable.length >= 3 && spreadMs && widestAt >= 0 && spreadMs[widestAt] >= 100 && !(findings[0] && findings[0].kind === 'sectorGain' && findings[0].sector === widestAt + 1)) {
      findings.push({ kind: 'sectorSpread', sector: widestAt + 1, stdDevMs: spreadMs[widestAt], laps: considered.length });
    }
  }
  if (usable.length >= 3 && stdDev !== null && stdDev >= 150) findings.push({ kind: 'consistency', stdDevMs: Math.round(stdDev), laps: considered.length });
  return {
    sessionId,
    source: 'metadata',
    lapsUsed: usable.length,
    lapsConsidered: considered.length,
    summary: { bestLapMs: best?.timeMs ?? null, bestLapId: best?.id ?? null, averageMs: considered.length ? Math.round(mean(considered.map((lap) => lap.timeMs))) : null, consistencyMs: stdDev === null ? null : Math.round(stdDev), sectors },
    findings: findings.slice(0, 2),
  };
}
