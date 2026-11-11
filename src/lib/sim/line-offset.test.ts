import { describe, expect, it } from 'vitest';
import { offLineStretches, offsetsFromLine } from './line-offset';

// A straight ideal line along +x. Driving along +x, the driver's left is -z (left = (t.z, -t.x) = (0, -1)).
const straight = { x: [0, 100, 200], z: [0, 0, 0], closed: false };

describe('the offset from the ideal line', () => {
  it('is the sideways distance, positive to the left of the direction of travel', () => {
    const offsets = offsetsFromLine(straight, [10, 50, 150], [-2, 0, 3]);
    expect(offsets[0]).toBeCloseTo(2);
    expect(offsets[1]).toBeCloseTo(0);
    expect(offsets[2]).toBeCloseTo(-3);
  });

  it('gives NaN where the lap has no position', () => {
    expect(offsetsFromLine(straight, [10, Number.NaN], [1, 1])[1]).toBeNaN();
  });

  it('follows the lap round a closed line, past the point where it closes', () => {
    // A square of 100 m driven anticlockwise on screen (x right, z down): its left is the outside here.
    const square = { x: [0, 100, 100, 0], z: [0, 0, 100, 100], closed: true };
    const offsets = offsetsFromLine(square, [50, 101, 50, -1], [-1, 50, 101, 50]);
    expect(offsets.map((o) => Math.round(o))).toEqual([1, 1, 1, 1]);
  });

  it('does not take the other side of a hairpin for the part being driven', () => {
    // There and back, 10 m apart: a point 4 m off the outward leg is 6 m off the return leg.
    const hairpin = { x: [...Array.from({ length: 300 }, (_, i) => i), ...Array.from({ length: 300 }, (_, i) => 299 - i)], z: [...Array(300).fill(0), ...Array(300).fill(10)], closed: false };
    const lapX = [10, 100, 200, 290];
    const lapZ = [4, 4, 4, 4];
    const offsets = offsetsFromLine(hairpin, lapX, lapZ);
    expect(offsets.every((o) => Math.abs(Math.abs(o) - 4) < 0.01)).toBe(true);
  });
});

describe('the stretches off the ideal line', () => {
  const grid = Array.from({ length: 101 }, (_, i) => i * 10); // 0..1000 m
  const offsets = grid.map((d) => (d >= 100 && d <= 200 ? 3 : d >= 500 && d <= 560 ? -2 : d >= 800 && d <= 810 ? 5 : 0.2));

  it('finds where the lap kept to one side long enough, with the side and the furthest point', () => {
    const stretches = offLineStretches(grid, offsets, null);
    expect(stretches.map((s) => [s.fromM, s.toM, s.side, s.maxM])).toEqual([
      [100, 200, 'left', 3],
      [500, 560, 'right', -2],
    ]);
    expect(stretches[0].seconds).toBeNull();
  });

  it('puts first the one that cost the most time, when there is a reference', () => {
    const gap = grid.map((d) => (d < 500 ? 0 : d < 560 ? ((d - 500) / 60) * 0.3 : 0.3));
    const [first] = offLineStretches(grid, offsets, gap);
    expect(first.fromM).toBe(500);
    expect(first.seconds).toBeCloseTo(0.3);
  });
});
