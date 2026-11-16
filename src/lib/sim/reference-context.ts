import type { LapFile, LapHeader } from './lap-file';

export type ComparisonGoal = 'practice' | 'qualifying' | 'race';

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
