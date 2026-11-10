import { describe, expect, it } from 'vitest';
import { comparable, distanceGrid, gapSeries, lapLength, lapStats, resampleLap, timeChanges, trackPath } from './analysis';
import { gunzipLap, gzipLap, packLap, unpackLap } from './lap-file';
import { makeSampleLaps } from './sample-laps';

describe('the sample laps', () => {
  const [mine, best] = makeSampleLaps();

  it('are two laps the strict lap file rules accept, and that survive a round trip', async () => {
    for (const lap of [mine, best]) {
      const back = unpackLap(packLap(lap));
      expect(back.header).toEqual(lap.header);
      expect(Array.from(back.data.speed.slice(0, 50))).toEqual(Array.from(lap.data.speed.slice(0, 50)));
      expect((await gunzipLap(await gzipLap(lap))).header.sampleCount).toBe(lap.header.sampleCount);
    }
  });

  it('are on the same track and can be compared', () => {
    expect(mine.header.track).toEqual(best.header.track);
    expect(comparable(mine, best)).toBe(true);
    expect(Math.abs(lapLength(mine) - lapLength(best))).toBeLessThan(1);
    expect(lapLength(mine)).toBe(mine.header.track.lengthM);
  });

  it('take a plausible time, and the first is a little slower', () => {
    for (const lap of [mine, best]) expect(lap.header.lap.timeMs).toBeGreaterThan(40_000);
    for (const lap of [mine, best]) expect(lap.header.lap.timeMs).toBeLessThan(120_000);
    const lost = (mine.header.lap.timeMs - best.header.lap.timeMs) / 1000;
    expect(lost).toBeGreaterThan(0.1);
    expect(lost).toBeLessThan(3);
  });

  it('keep every channel finite, in range, and the distance and time going forward', () => {
    for (const lap of [mine, best]) {
      const { t, dist, speed, throttle, brake, steer } = lap.data;
      for (let i = 1; i < t.length; i++) {
        expect(t[i]).toBeGreaterThan(t[i - 1]);
        expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
      }
      expect(dist[0]).toBe(0);
      for (const id of Object.keys(lap.data)) expect(Array.from(lap.data[id]).every(Number.isFinite)).toBe(true);
      expect(Math.max(...speed)).toBeLessThanOrEqual(84.01);
      expect(Math.min(...speed)).toBeGreaterThan(5);
      expect(Math.min(...throttle)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...throttle)).toBeLessThanOrEqual(1);
      expect(Math.max(...brake)).toBeLessThanOrEqual(1);
      expect(Math.max(...brake)).toBeGreaterThan(0.2);
      expect(Math.max(...steer.map(Math.abs))).toBeLessThanOrEqual(1);
    }
  });

  it('draw a closed line', () => {
    const path = trackPath(best)!;
    expect(path.points.length).toBeGreaterThan(100);
    const [first, last] = [path.points[0], path.points[path.points.length - 1]];
    expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeLessThan(60);
  });

  it('are the same every time', () => {
    const again = makeSampleLaps();
    expect(again[0].header).toEqual(mine.header);
    expect(Array.from(again[1].data.speed.slice(0, 100))).toEqual(Array.from(best.data.speed.slice(0, 100)));
  });

  it('show the lost time at one corner, which is what the analysis should find', () => {
    const grid = distanceGrid(lapLength(mine));
    const gap = gapSeries(resampleLap(mine, ['t'], grid).t, resampleLap(best, ['t'], grid).t);
    const finalGap = gap[gap.length - 1];
    expect(finalGap).toBeCloseTo((mine.header.lap.timeMs - best.header.lap.timeMs) / 1000, 1);
    const { losses } = timeChanges(grid, gap);
    expect(losses.length).toBeGreaterThan(0);
    // Most of the lost time sits in one or two stretches, not spread evenly.
    expect(losses[0].seconds).toBeGreaterThan(finalGap * 0.3);
    expect(lapStats(mine).topSpeedMs).toBeLessThanOrEqual(lapStats(best).topSpeedMs + 0.01);
  });
});
