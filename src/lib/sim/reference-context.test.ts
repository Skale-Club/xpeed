import { describe, expect, it } from 'vitest';
import { makeLapFixtures } from '@/test/lap-fixture';
import { comparisonGoal, referenceDifferences } from './reference-context';
import { incomparableReason } from './analysis';

const [lap] = makeLapFixtures();

describe('comparison reference context', () => {
  it('uses the recorded objective when available', () => {
    expect(comparisonGoal({ ...lap.header, sessionKind: 'race' })).toBe('race');
    expect(comparisonGoal({ ...lap.header, sessionKind: 'qualifying' })).toBe('qualifying');
    expect(comparisonGoal()).toBe('practice');
  });

  it('reports known differences without claiming unknown conditions match', () => {
    const a = { ...lap, header: { ...lap.header, weather: 'dry', tyreCompound: 'Soft' }, data: { ...lap.data, fuel: new Float32Array([Number.NaN, 30]) } };
    const b = { ...lap, header: { ...lap.header, weather: 'rain', tyreCompound: 'Hard' }, data: { ...lap.data, fuel: new Float32Array([10]) } };
    expect(referenceDifferences(a, b)).toEqual(['weather', 'tyres', 'fuel']);
    expect(referenceDifferences(lap, { ...lap, data: { ...lap.data, fuel: new Float32Array([Number.NaN]) } })).not.toContain('fuel');
  });

  it('refuses different layouts even when their distances match', () => {
    const a = { ...lap, header: { ...lap.header, track: { ...lap.header.track, variant: 'GP' } } };
    const b = { ...lap, header: { ...lap.header, track: { ...lap.header.track, variant: 'Short' } } };
    expect(incomparableReason(a, b)).toBe('track');
    expect(incomparableReason(a, { ...a, header: { ...a.header, track: { ...a.header.track, variant: ' gp ' } } })).toBeNull();
  });
});
