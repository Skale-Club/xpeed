import { describe, expect, it } from 'vitest';
import { boxSmooth, fillGaps, lapView, makeGrid, mean, median, round, stdDev, valueAt } from './lap-series';
import { buildSyntheticLap } from './synthetic-lap';

describe('lap series helpers', () => {
  it('makes a grid from 0 to exactly the length, with a capped number of points', () => {
    const grid = makeGrid(1001, 2);
    expect(grid[0]).toBe(0);
    expect(grid[grid.length - 1]).toBe(1001);
    expect(makeGrid(100_000, 2, 500)).toHaveLength(500);
    expect(Array.from(makeGrid(0))).toEqual([0]);
  });

  it('fills gaps by a straight line and holds the ends', () => {
    const filled = fillGaps(Float64Array.from([Number.NaN, 2, Number.NaN, Number.NaN, 8, Number.NaN]));
    expect(Array.from(filled as Float64Array)).toEqual([2, 2, 4, 6, 8, 8]);
    expect(fillGaps(Float64Array.from([Number.NaN, Number.NaN]))).toBeNull();
  });

  it('smooths with a moving average that shrinks at the ends', () => {
    const out = boxSmooth(Float64Array.from([0, 0, 9, 0, 0]), 3);
    expect(Array.from(out)).toEqual([0, 3, 3, 3, 0]);
    expect(Array.from(boxSmooth(Float64Array.from([1, 2, 3]), 1))).toEqual([1, 2, 3]);
  });

  it('reads a series at any distance', () => {
    const grid = Float64Array.from([0, 10, 20]);
    expect(valueAt(grid, [0, 100, 300], 5)).toBe(50);
    expect(valueAt(grid, [0, 100, 300], 15)).toBe(200);
    expect(valueAt(grid, [0, 100, 300], -5)).toBe(0);
    expect(valueAt(grid, [0, 100, 300], 99)).toBe(300);
  });

  it('computes the usual statistics, ignoring missing values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
    expect(mean([1, Number.NaN, 3])).toBe(2);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    expect(stdDev([5])).toBe(0);
    expect(round(1.23456, 2)).toBe(1.23);
  });

  it('views a lap: its length, a channel on a grid, and the nearest raw sample', () => {
    const { lap } = buildSyntheticLap({ lengthM: 1000, corners: [], hz: 20 });
    const view = lapView(lap);
    expect(view.length).toBeCloseTo(1000, 3);
    expect(view.has('speed')).toBe(true);
    expect(view.has('rpm')).toBe(false);
    const grid = makeGrid(view.length, 100);
    const speed = view.sample('speed', grid);
    expect(speed).toHaveLength(grid.length);
    expect(speed.every(Number.isFinite)).toBe(true);
    expect(view.sample('rpm', grid).every(Number.isNaN)).toBe(true);
    expect(view.nearest('gear', 500)).toBe(6);
    expect(view.nearest('rpm', 500)).toBeNaN();
  });
});
