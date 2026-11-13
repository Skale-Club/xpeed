import { describe, expect, it } from 'vitest';
import { compareCorners } from '@/lib/sim/corner-compare';
import { buildSyntheticLap, exampleCorners, type SynthCorner } from '@/lib/sim/synthetic-lap';
import { EVEN_S, ZOOM_PAD_M, cornerRange, cornerRows, toneOf, unmatchedCorners } from '@/lib/sim/corner-table';

const LENGTH = 4200;
const lapWith = (patch: (corners: SynthCorner[]) => SynthCorner[] = (c) => c) => buildSyntheticLap({ lengthM: LENGTH, corners: patch(exampleCorners()), hz: 20 }).lap;
const reference = lapWith();
/** The hairpin brakes 15 m earlier and the last corner carries 8 km/h less; the medium right is a little faster. */
const study = lapWith((corners) => corners.map((c, i) => (i === 1 ? { ...c, brakeDist: c.brakeDist - 15 } : i === 5 ? { ...c, minSpeedKmh: c.minSpeedKmh - 8 } : i === 0 ? { ...c, minSpeedKmh: c.minSpeedKmh + 5, exitSpeedKmh: c.exitSpeedKmh + 5 } : c)));
const comparison = compareCorners(study, reference);

describe('the corner rows', () => {
  it('are one per corner, in the order of the track', () => {
    const rows = cornerRows(comparison);
    expect(rows.map((row) => row.corner.index)).toEqual([...comparison.corners.map((c) => c.index)].sort((p, q) => p - q));
    expect(rows.length).toBe(comparison.corners.length);
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('can put the corner that lost the most first', () => {
    const rows = cornerRows(comparison, 'loss');
    const deltas = rows.map((row) => row.corner.deltaTime);
    expect(deltas).toEqual([...deltas].sort((p, q) => q - p));
    expect(rows[0].corner.deltaTime).toBeGreaterThan(0.05);
    // Same corners, other order.
    expect(rows.map((row) => row.corner.index).sort()).toEqual(cornerRows(comparison).map((row) => row.corner.index).sort());
  });

  it('colour a loss, a gain and an even corner differently', () => {
    expect(toneOf(0.2)).toBe('loss');
    expect(toneOf(-0.2)).toBe('gain');
    expect(toneOf(0)).toBe('even');
    expect(toneOf(EVEN_S)).toBe('even');
    expect(toneOf(-EVEN_S)).toBe('even');
    const tones = new Map(cornerRows(comparison).map((row) => [row.corner.index, row.tone]));
    expect(tones.get(2)).toBe('loss'); // the hairpin, braked too early
    expect(tones.get(4)).toBe('loss'); // the last corner, slower through the apex
    expect(tones.get(1)).toBe('gain'); // the first corner, faster
    expect(cornerRows(comparison).every((row) => row.tone === toneOf(row.corner.deltaTime))).toBe(true);
  });

  it('carry the differences the table shows', () => {
    const hairpin = cornerRows(comparison).find((row) => row.corner.index === 2)!.corner;
    expect(hairpin.brakePointM as number).toBeLessThan(-10);
    expect(hairpin.dominantCause).toBe('brakesEarly');
  });
});

describe('the stretch a click on a corner zooms to', () => {
  it('is the corner with road before and after it', () => {
    const corner = comparison.corners.find((c) => c.index === 2)!;
    const range = cornerRange(corner, LENGTH);
    expect(range.fromM).toBeCloseTo(corner.startDist - ZOOM_PAD_M, 5);
    expect(range.toM).toBeCloseTo(corner.endDist + ZOOM_PAD_M, 5);
    expect(range.fromM).toBeLessThan(corner.apexDist);
    expect(range.toM).toBeGreaterThan(corner.apexDist);
  });

  it('never goes past the start line or the finish line', () => {
    expect(cornerRange({ startDist: 10, endDist: 50 }, 4200)).toEqual({ fromM: 0, toM: 50 + ZOOM_PAD_M });
    expect(cornerRange({ startDist: 4100, endDist: 4190 }, 4200)).toEqual({ fromM: 4100 - ZOOM_PAD_M, toM: 4200 });
  });

  it('falls back to the whole lap for a corner with no extent', () => {
    expect(cornerRange({ startDist: 5000, endDist: 5001 }, 4200)).toEqual({ fromM: 0, toM: 4200 });
  });
});

describe('the corners only one lap has', () => {
  it('are listed apart, each on the lap that had it, never paired with a wrong corner', () => {
    // The reference has no hairpin: the lap has a corner the reference does not.
    const noHairpin = lapWith((corners) => corners.filter((_, i) => i !== 1));
    const cmp = compareCorners(study, noHairpin);
    const apart = unmatchedCorners(cmp);
    expect(apart.length).toBeGreaterThan(0);
    expect(apart.every((c) => c.side === 'lap')).toBe(true);
    expect(apart.some((c) => Math.abs(c.apexM - 1040) < 60)).toBe(true);
    expect(cmp.corners.every((c) => Math.abs(c.apexDist - 1040) > 60)).toBe(true);
    expect(apart.every((c) => c.minSpeedKmh > 0)).toBe(true);

    const other = unmatchedCorners(compareCorners(noHairpin, study));
    // The other way round, the corner belongs to the reference.
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((c) => c.side === 'reference')).toBe(true);
  });

  it('are none when the two laps have the same corners', () => {
    expect(unmatchedCorners(comparison)).toEqual([]);
  });
});
