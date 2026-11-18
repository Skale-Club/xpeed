import type { LapFile, LapHeader } from './lap-file.ts';

export type ComparisonGoal = 'practice' | 'qualifying' | 'race';

/** The reflection landed inside 0.8.2, not at its version boundary (commit 9c36958). */
export function evoCoordinateFrame(header: LapHeader): 'original' | 'reflected' | 'unknown' {
  if (header.game !== 'acevo' || !header.recorder) return 'unknown';
  const explicit = header.recorder.coordinateFrame;
  if (explicit === 'acevo-reflected-x-v1') return 'reflected';
  if (explicit === 'acevo-original-x-v1') return 'original';
  // An explicit future convention takes precedence over historical build hints.
  if (explicit !== undefined) return 'unknown';
  const build = header.recorder.build.toLowerCase();
  if (build === 'd821333' || build === 'd821333f5e29a26e69a542a1fb820192c1fe7ef8') return 'original';
  if (build === '9c36958' || build === '9c3695888bef108a6830c0a0c2416227ab326ab7') return 'reflected';
  return 'unknown';
}

export function coordinateFramesDiffer(a: LapHeader, b: LapHeader) {
  if (a.game !== 'acevo' || b.game !== 'acevo') return false;
  const first = evoCoordinateFrame(a), second = evoCoordinateFrame(b);
  return first !== 'unknown' && second !== 'unknown' && first !== second;
}

export function referenceVersionContext(a: LapHeader, b: LapHeader) {
  const first = a.recorder?.gameBuild?.trim(), second = b.recorder?.gameBuild?.trim();
  return {
    gameBuild: first && second ? first === second ? 'same' as const : 'different' as const : 'unknown' as const,
    coordinatesUnknown: a.game === 'acevo' && b.game === 'acevo' && (evoCoordinateFrame(a) === 'unknown' || evoCoordinateFrame(b) === 'unknown'),
  };
}

export function comparisonGoal(header?: LapHeader): ComparisonGoal {
  return header?.sessionKind === 'race' ? 'race' : header?.sessionKind === 'qualifying' ? 'qualifying' : 'practice';
}

/** Informative differences, never a claim that missing conditions match. */
export function referenceDifferences(a: LapFile, b: LapFile): Array<'weather' | 'tyres' | 'fuel'> {
  const differences: Array<'weather' | 'tyres' | 'fuel'> = [];
  const different = (x?: string, y?: string) => !!x && !!y && x.trim().toLowerCase() !== y.trim().toLowerCase();
  if (different(a.header.weather, b.header.weather)) differences.push('weather');
  if (different(a.header.tyreCompound, b.header.tyreCompound)) differences.push('tyres');
  const firstFuel = (lap: LapFile) => lap.data.fuel?.find((value) => Number.isFinite(value) && value >= 0);
  const fuelA = firstFuel(a), fuelB = firstFuel(b);
  // A useful heads-up about a materially different load, not a matching tolerance or eligibility rule.
  if (fuelA !== undefined && fuelB !== undefined && Math.abs(fuelA - fuelB) >= 5) differences.push('fuel');
  return differences;
}
