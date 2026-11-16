import { describe, expect, it } from 'vitest';
import type { LapFile } from './lap-file';
import { makeLayout } from '@/test/track-fixture';
import {
  createPerspectiveProjector, drawPerspective, perspectiveAtTime, perspectiveGroundAlpha,
  perspectiveHeading, preparePerspectiveLap, preparePerspectiveRoad,
} from './track-perspective';

function lap(points = Array.from({ length: 101 }, (_, i) => [0, i * 5] as [number, number])): LapFile {
  const data = {
    x: Float32Array.from(points.map(p => p[0])), z: Float32Array.from(points.map(p => p[1])),
    t: Float32Array.from(points.map((_, i) => i / 10)), dist: Float32Array.from(points.map((_, i) => i * 5)),
    speed: new Float32Array(points.length).fill(50),
  };
  return { header: { game: 'ac', track: { name: 'Test Track' }, car: { name: 'Test car' }, lap: { number: 1, timeMs: 10000, valid: true }, startedAt: '2026-01-01T00:00:00Z', sampleRateHz: 10, sampleCount: points.length, channels: Object.keys(data).map(id => ({ id, unit: id === 't' ? 's' : id === 'speed' ? 'm/s' : 'm' })) }, data };
}

describe('recorded local track geometry', () => {
  it('uses recorded time, rather than distance, for playback sampling', () => {
    const file = lap([[0, 0], [0, 5], [0, 25]]); file.data.t.set([0, .5, 1]);
    const model = preparePerspectiveLap(file);
    expect(perspectiveAtTime(model, .75)?.z).toBeCloseTo(15);
  });

  it('keeps NaNs, clock gaps and teleports as separate runs without bridges', () => {
    const file = lap(); file.data.x[3] = NaN; file.data.t[20] = 5;
    file.data.x[80] = 5000;
    const model = preparePerspectiveLap(file);
    expect(model.runs.length).toBeGreaterThan(3);
    expect(perspectiveAtTime(model, .35)).toBeNull();
    for (const run of model.runs) for (let i = 1; i < run.length; i++) expect(Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z)).toBeLessThan(30);
  });

  it('handles coarse repeated timestamps, zero motion and missing channels finitely', () => {
    const file = lap([[0, 0], [0, 0], [0, 5], [0, 10]]); file.data.t.set([0, 0, 0, 1]);
    const model = preparePerspectiveLap(file);
    expect(perspectiveAtTime(model, 0)?.z).toBe(5);
    expect(perspectiveAtTime(model, .5)?.z).toBeCloseTo(7.5);
    expect(preparePerspectiveLap({ ...file, data: { t: file.data.t, dist: file.data.dist } }).points).toHaveLength(0);
  });

  it.each([320, 736])('anchors the camera and keeps both bend headings upward at %i px', width => {
    for (const sign of [-1, 1]) {
      const file = lap(Array.from({ length: 101 }, (_, i) => [sign * .01 * i * i, i * 3]));
      const model = preparePerspectiveLap(file), sample = perspectiveAtTime(model, 5)!;
      const [tx, tz] = perspectiveHeading(model, sample)!;
      const projector = createPerspectiveProjector({ x: sample.x, z: sample.z, tx, tz, width, height: 400, zoom: 1, tilt: 32 });
      expect(projector.project([sample.x, sample.z])).toEqual([width / 2, 304]);
      const forward = projector.project([sample.x + tx * 20, sample.z + tz * 20])!;
      expect(forward[0]).toBeCloseTo(width / 2); expect(forward[1]).toBeLessThan(304);
    }
  });

  it('fades ground in screen space while leaving the car independent', () => {
    expect(perspectiveGroundAlpha(280)).toBe(1);
    expect(perspectiveGroundAlpha(344)).toBeCloseTo(.5);
    expect(perspectiveGroundAlpha(400)).toBe(0);
  });

  it('never invents road widths or fits another world layout to the lap', () => {
    const file = lap(), model = preparePerspectiveLap(file), points = Array.from({ length: 101 }, (_, i) => [0, i * 5] as [number, number]);
    expect(preparePerspectiveRoad(null, file, model).matched).toBe(false);
    expect(preparePerspectiveRoad(makeLayout({ points }), file, model).points).toHaveLength(0);
    expect(preparePerspectiveRoad(makeLayout({ points: points.map(([x, z]) => [x + 1000, z]), width: 7 }), file, model).matched).toBe(false);
    const road = preparePerspectiveRoad(makeLayout({ points, width: 7 }), file, model);
    expect(road.matched).toBe(true); expect(road.points[0].left).toEqual([7, 0]); expect(road.points[0].right).toEqual([-7, 0]);
  });

  it('limits road and actual reference traces to the current local progression', () => {
    const file = lap(), model = preparePerspectiveLap(file), sample = perspectiveAtTime(model, 2)!;
    const road = preparePerspectiveRoad(null, file, model);
    const drawing = drawPerspective(model, sample, { x: sample.x, z: sample.z, tx: 0, tz: 1, width: 320, height: 400, zoom: 1, tilt: 32 }, road, model);
    expect(drawing.reference).toBe(drawing.study); expect(drawing.road).toBe('');
    expect((drawing.study.match(/L/g) ?? []).length).toBeLessThan(70);
    expect(drawing.study).not.toMatch(/NaN|Infinity/);
  });

  it('clips behind the camera and rejects invalid world coordinates', () => {
    const projector = createPerspectiveProjector({ x: 0, z: 0, tx: 0, tz: 1, width: NaN, height: 400, zoom: NaN, tilt: NaN });
    expect(projector.project([NaN, 0])).toBeNull(); expect(projector.project([0, -1000])).toBeNull();
    expect(projector.polygon([[-5, -100], [-5, 30], [5, 30], [5, -100]]).flat().every(Number.isFinite)).toBe(true);
  });
});
