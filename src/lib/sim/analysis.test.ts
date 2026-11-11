import { describe, expect, it } from 'vitest';
import {
  comparable, distanceGrid, formatGap, formatLapTime, gapSeries, lapLength, lapStats, lengthIn, lengthLabel, resampleLap, sampleAlong,
  speedIn, speedLabel, timeChanges, trackPath,
} from './analysis';
import type { LapFile } from './lap-file';

/** A lap of `length` meters at `speed` m/s, one sample per meter; `extra(d)` adds seconds lost by distance d. */
function lapOf(options: { speed?: number; length?: number; extra?: (d: number) => number; track?: string; game?: string } = {}): LapFile {
  const { speed = 50, length = 1000, extra = () => 0, track = 'Test Ring', game = 'lmu' } = options;
  const n = length + 1;
  const d = Float32Array.from({ length: n }, (_, i) => i);
  const t = Float32Array.from(d, (m) => m / speed + extra(m));
  const channels = ['t', 'dist', 'speed', 'throttle', 'brake', 'x', 'z'];
  return {
    header: {
      game,
      track: { name: track },
      car: { name: 'Car' },
      lap: { number: 1, timeMs: Math.round(t[n - 1] * 1000), valid: true },
      startedAt: '2026-01-01T00:00:00.000Z',
      sampleRateHz: 50,
      sampleCount: n,
      channels: channels.map((id) => ({ id, unit: id === 't' ? 's' : id === 'dist' || id === 'x' || id === 'z' ? 'm' : id === 'speed' ? 'm/s' : 'ratio' })),
    },
    data: {
      t, dist: d, speed: new Float32Array(n).fill(speed), throttle: new Float32Array(n).fill(1), brake: new Float32Array(n),
      x: Float32Array.from(d, (m) => Math.cos(m / 100) * 100), z: Float32Array.from(d, (m) => Math.sin(m / 100) * 100),
    },
  };
}

describe('the distance grid', () => {
  it('runs from 0 to exactly the lap length', () => {
    const grid = distanceGrid(3000);
    expect(grid[0]).toBe(0);
    expect(grid[grid.length - 1]).toBe(3000);
    expect(grid.length).toBe(1200);
  });
  it('has a point every 2 m on a short lap and never more than the cap on a long one', () => {
    expect(distanceGrid(100).length).toBe(51);
    expect(distanceGrid(25_000, 800).length).toBe(800);
  });
  it('is a single point for a lap with no length', () => {
    expect(distanceGrid(0)).toEqual([0]);
    expect(distanceGrid(Number.NaN)).toEqual([0]);
  });
});

describe('sampling a channel along the distance', () => {
  const distance = Float64Array.from([0, 10, 20, 30]);
  it('interpolates between samples', () => {
    expect(sampleAlong(distance, [0, 100, 200, 300], [0, 5, 15, 30])).toEqual([0, 50, 150, 300]);
  });
  it('holds the first value before the first sample and has no value past the last', () => {
    const out = sampleAlong(Float64Array.from([5, 15]), [1, 3], [0, 5, 10, 15, 20]);
    expect(out.slice(0, 4)).toEqual([1, 1, 2, 3]);
    expect(Number.isNaN(out[4])).toBe(true);
  });
  it('does not divide by zero while the car is stopped', () => {
    // 20 samples with the car standing at 10 m, then it moves on.
    const stopped = Float64Array.from([0, 10, 10, 10, 20]);
    const out = sampleAlong(stopped, [0, 1, 2, 3, 4], [10, 15, 20]);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out[2]).toBe(4);
  });
  it('keeps a missing sample missing, and what is interpolated against it', () => {
    const out = sampleAlong(distance, [0, Number.NaN, 200, 300], [5, 10, 15, 25]);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(Number.isNaN(out[2])).toBe(true);
    expect(out[3]).toBe(250);
  });
  it('copes with a distance column that goes back or has holes', () => {
    const lap = lapOf({ length: 10 });
    lap.data.dist[5] = 2; // goes back
    lap.data.dist[7] = Number.NaN; // missing
    const out = resampleLap(lap, ['t'], [0, 3, 6, 9, 10]).t;
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out.every((v, i) => i === 0 || v >= out[i - 1])).toBe(true);
  });
  it('gives NaN for a channel the lap does not have', () => {
    expect(resampleLap(lapOf(), ['gear'], [0, 100]).gear.every(Number.isNaN)).toBe(true);
  });
});

describe('the gap between two laps', () => {
  const grid = distanceGrid(1000);
  const time = (lap: LapFile) => resampleLap(lap, ['t'], grid).t;

  it('is negative all along when lap A is faster, and grows steadily', () => {
    const gap = gapSeries(time(lapOf({ speed: 50 })), time(lapOf({ speed: 40 })));
    expect(gap[0]).toBe(0);
    expect(gap[gap.length - 1]).toBeCloseTo(1000 / 50 - 1000 / 40, 3);
    expect(gap.every((v, i) => i === 0 || v <= gap[i - 1] + 1e-9)).toBe(true);
  });

  it('puts the time lost in the stretch where it was lost', () => {
    // A is as fast as B except for 0.3 s lost between 450 and 600 m.
    const a = lapOf({ extra: (d) => (d <= 450 ? 0 : d >= 600 ? 0.3 : ((d - 450) / 150) * 0.3) });
    const b = lapOf();
    const gap = gapSeries(time(a), time(b));
    const { losses, gains } = timeChanges(grid, gap);
    expect(gains).toEqual([]);
    expect(losses).toHaveLength(1);
    expect(losses[0].fromM).toBe(450);
    expect(losses[0].toM).toBe(600);
    expect(losses[0].seconds).toBeCloseTo(0.3, 2);
  });

  it('reports gains as negative, largest first, and ignores noise', () => {
    const faster = lapOf({ speed: 50 });
    const slower = lapOf({ speed: 40 });
    const { losses, gains } = timeChanges(grid, gapSeries(time(faster), time(slower)), { count: 2 });
    expect(losses).toEqual([]);
    expect(gains).toHaveLength(2);
    expect(gains[0].seconds).toBeLessThan(0);
    expect(gains[0].seconds).toBeLessThanOrEqual(gains[1].seconds);
    const same = timeChanges(grid, gapSeries(time(slower), time(slower)));
    expect(same.losses).toEqual([]);
    expect(same.gains).toEqual([]);
  });

  it('skips stretches where either lap has no time', () => {
    const gap = new Array<number>(grid.length).fill(Number.NaN);
    expect(timeChanges(grid, gap)).toEqual({ losses: [], gains: [] });
  });
});

describe('which laps can be compared', () => {
  it('needs the same game, track and (nearly) the same length', () => {
    expect(comparable(lapOf(), lapOf({ speed: 45 }))).toBe(true);
    expect(comparable(lapOf(), lapOf({ track: 'test ring ' }))).toBe(true);
    expect(comparable(lapOf(), lapOf({ track: 'Other Ring' }))).toBe(false);
    expect(comparable(lapOf(), lapOf({ game: 'acc' }))).toBe(false);
    expect(comparable(lapOf({ length: 1000 }), lapOf({ length: 1020 }))).toBe(true);
    expect(comparable(lapOf({ length: 1000 }), lapOf({ length: 1100 }))).toBe(false);
  });
  it('measures the length of a lap by its largest distance', () => {
    expect(lapLength(lapOf({ length: 1234 }))).toBe(1234);
  });
});

describe('a lap in numbers', () => {
  it('gives the top and average speed, the time and the shares', () => {
    const lap = lapOf({ speed: 50, length: 1000 });
    lap.data.speed[500] = 80;
    for (let i = 0; i < 250; i++) lap.data.brake[i] = 0.5;
    for (let i = 0; i < 100; i++) lap.data.throttle[i] = 0;
    const stats = lapStats(lap);
    expect(stats.distanceM).toBe(1000);
    expect(stats.durationS).toBeCloseTo(20, 3);
    expect(stats.topSpeedMs).toBe(80);
    expect(stats.averageSpeedMs).toBeCloseTo(50, 3);
    expect(stats.brakingShare).toBeCloseTo(250 / 1001, 5);
    expect(stats.fullThrottleShare).toBeCloseTo(901 / 1001, 5);
  });
  it('copes with a lap that has none of those channels', () => {
    const lap = lapOf();
    delete lap.data.speed;
    delete lap.data.throttle;
    delete lap.data.brake;
    const stats = lapStats(lap);
    expect([stats.topSpeedMs, stats.fullThrottleShare, stats.brakingShare]).toEqual([0, 0, 0]);
  });
});

describe('the line the car drove', () => {
  it('thins the points and gives the bounds', () => {
    const path = trackPath(lapOf({ length: 5000 }), 500)!;
    expect(path.points.length).toBeLessThanOrEqual(500);
    expect(path.points.length).toBeGreaterThan(400);
    expect(path.minX).toBeGreaterThanOrEqual(-100);
    expect(path.maxX).toBeLessThanOrEqual(100);
  });
  it('is null without positions', () => {
    const lap = lapOf();
    delete lap.data.x;
    expect(trackPath(lap)).toBeNull();
  });
});

describe('words and units', () => {
  it('writes lap times like a clock', () => {
    expect(formatLapTime(207_250)).toBe('3:27.250');
    expect(formatLapTime(59_999)).toBe('0:59.999');
    expect(formatLapTime(-5)).toBe('0:00.000');
  });
  it('writes a gap with its sign', () => {
    expect(formatGap(0.1234)).toBe('+0.123');
    expect(formatGap(-1.5)).toBe('-1.500');
    expect(formatGap(0)).toBe('0.000');
    expect(formatGap(Number.NaN)).toBe('–');
  });
  it('converts speed and length to the chosen unit', () => {
    expect(speedIn(50, 'km')).toBeCloseTo(180, 5);
    expect(speedIn(50, 'mi')).toBeCloseTo(111.8468, 3);
    expect([speedLabel('km'), speedLabel('mi'), lengthLabel('km'), lengthLabel('mi')]).toEqual(['km/h', 'mph', 'm', 'ft']);
    expect(lengthIn(1000, 'km')).toBe(1000);
    expect(lengthIn(1000, 'mi')).toBeCloseTo(3280.84, 2);
  });
});
