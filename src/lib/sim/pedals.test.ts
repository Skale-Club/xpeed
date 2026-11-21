import { describe, expect, it } from 'vitest';
import { pedalRuns, pedalState } from './pedals';

describe('what the feet are doing at a point', () => {
  it('is braking whenever the brake is pressed (even with the throttle still down), else on the throttle, else on neither', () => {
    expect(pedalState(1, 0)).toBe('throttle');
    expect(pedalState(0, 0.6)).toBe('brake');
    expect(pedalState(0.8, 0.3)).toBe('brake');
    expect(pedalState(0, 0)).toBe('coast');
  });

  it('does not count a resting foot or sensor noise (under 5 % of the travel) as a press, nor a missing value', () => {
    expect(pedalState(0.04, 0.04)).toBe('coast');
    expect(pedalState(Number.NaN, Number.NaN)).toBe('coast');
  });
});

describe('the lap as stretches of one pedal each', () => {
  // A straight on the throttle, a braking zone, then nothing, then the throttle again.
  const lap = {
    x: [0, 10, 20, 30, 40, 50, 60, 70],
    z: [0, 0, 0, 0, 10, 20, 30, 40],
    speed: [50, 55, 60, 50, 40, 35, 38, 45],
    throttle: [1, 1, 1, 0, 0, 0, 0.5, 1],
    brake: [0, 0, 0, 0.9, 0.7, 0, 0, 0],
  };

  it('follows the lap in order, one stretch per change of pedal, each joined to the next', () => {
    const { runs } = pedalRuns(lap);
    expect(runs.map((run) => run.state)).toEqual(['throttle', 'brake', 'coast', 'throttle']);
    // A stretch ends on the first point of the next one: the line has no gaps.
    for (let i = 0; i + 1 < runs.length; i++) expect(runs[i].points.split(' ').at(-1)).toBe(runs[i + 1].points.split(' ')[0]);
  });

  it('fits the small map without mirroring: x grows to the right and z down, inside the 0 to 100 box', () => {
    const { at } = pedalRuns(lap);
    const [first, last] = [at(0)!, at(7)!];
    expect(last.x).toBeGreaterThan(first.x);
    expect(last.y).toBeGreaterThan(first.y);
    for (let i = 0; i < lap.x.length; i++) {
      const p = at(i)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  });

  it('draws nothing for a lap with no positions (a game that sends none)', () => {
    const none = { ...lap, x: lap.x.map(() => Number.NaN), z: lap.z.map(() => Number.NaN) };
    expect(pedalRuns(none).runs).toEqual([]);
    expect(pedalRuns(none).at(0)).toBeNull();
  });
});
