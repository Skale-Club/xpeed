import { describe, expect, it } from 'vitest';
import { makeLapFixtures } from '@/test/lap-fixture';
import { comparisonGoal, evoCoordinateFrame, referenceDifferences, referenceVersionContext } from './reference-context';
import { incomparableReason } from './analysis';

const [lap] = makeLapFixtures();

describe('EVO frame of laps recorded before the recorder block', () => {
  const header = (extra: Record<string, unknown>) => ({ ...lap.header, game: 'acevo', recorder: undefined, ...extra }) as typeof lap.header;
  it('is original before the reflection landed (commit 9c36958) and unknown after it', () => {
    expect(evoCoordinateFrame(header({ startedAt: '2026-11-16T16:20:00Z' }))).toBe('original');
    expect(evoCoordinateFrame(header({ startedAt: '2026-11-16T16:34:08Z' }))).toBe('original');
    expect(evoCoordinateFrame(header({ startedAt: '2026-11-16T16:34:09Z' }))).toBe('unknown');
    expect(evoCoordinateFrame(header({ startedAt: '2026-11-17T10:00:00Z' }))).toBe('unknown');
  });
  it('is unknown with a missing or invalid startedAt, and for other games', () => {
    expect(evoCoordinateFrame(header({ startedAt: undefined }))).toBe('unknown');
    expect(evoCoordinateFrame(header({ startedAt: 'not a date' }))).toBe('unknown');
    expect(evoCoordinateFrame({ ...header({ startedAt: '2026-11-16T16:20:00Z' }), game: 'ac' })).toBe('unknown');
  });
  it('keeps the recorder rules when a recorder is present', () => {
    const recorder = { app: 'xpeed-companion', source: 'acevo', version: '0.8.2', build: '9c36958' };
    expect(evoCoordinateFrame(header({ startedAt: '2026-11-16T16:20:00Z', recorder }))).toBe('reflected');
    expect(evoCoordinateFrame(header({ startedAt: '2026-11-16T16:20:00Z', recorder: { ...recorder, build: 'unknown' } }))).toBe('unknown');
  });
});

describe('comparison reference context', () => {
  const recorded = (build: string, gameBuild?: string) => ({ ...lap, header: { ...lap.header, game: 'acevo', recorder: { app: 'xpeed-companion', source: 'acevo', version: '0.8.2', build, gameBuild } } });
  it('uses explicit coordinate stamps, preserving unknown future conventions', () => {
    const stamped = (coordinateFrame: string, build = 'unknown') => ({ ...recorded(build).header, recorder: { ...recorded(build).header.recorder, coordinateFrame } });
    expect(referenceVersionContext(stamped('acevo-reflected-x-v1'), stamped('acevo-reflected-x-v1')).coordinatesUnknown).toBe(false);
    expect(incomparableReason({ ...lap, header: stamped('acevo-original-x-v1') }, { ...lap, header: stamped('acevo-reflected-x-v1') })).toBe('coordinates');
    expect(referenceVersionContext(stamped('future-v2', '9c36958'), stamped('acevo-reflected-x-v1')).coordinatesUnknown).toBe(true);
  });
  it('refuses proven EVO coordinate changes within the same recorder version', () => {
    expect(incomparableReason(recorded('d821333'), recorded('9c36958'))).toBe('coordinates');
    expect(incomparableReason(recorded('9c36958'), recorded('9c36958'))).toBeNull();
    expect(incomparableReason(recorded('unknown'), recorded('9c36958'))).toBeNull();
    expect(referenceVersionContext(recorded('unknown').header, recorded('9c36958').header).coordinatesUnknown).toBe(true);
  });
  it('shows game build differences as context and treats missing builds as unknown', () => {
    const a = recorded('9c36958', '0.9.1'), b = recorded('9c36958', '0.9.2');
    expect(referenceVersionContext(a.header, b.header).gameBuild).toBe('different');
    expect(incomparableReason(a, b)).toBeNull();
    expect(referenceVersionContext(a.header, recorded('9c36958').header).gameBuild).toBe('unknown');
  });
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
