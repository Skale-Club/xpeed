import { describe, expect, it } from 'vitest';
import { makeLapFixtures } from '@/test/lap-fixture';
import { planarLeftSign } from './ground-frame';
import { offsetsFromLine } from './line-offset';
import { detectCorners } from './corners';
import { buildSyntheticLap, exampleCorners } from './synthetic-lap';

const [sample] = makeLapFixtures();
const recorder = { app: 'xpeed-companion', version: '0.8.2', build: 'unverified', source: 'acevo' };

describe('recorded ground handedness', () => {
  it('keeps physical left and right consistent for AC and iRacing without altering coordinates', () => {
    for (const game of ['ac', 'iracing']) {
      const leftSign = planarLeftSign({ ...sample.header, game })!;
      const x = [0, 0, 0], z = [0, 50, 100];
      // Heading +z in these sources: +x is physical left, -x is right.
      expect(offsetsFromLine({ x, z, closed: false, leftSign }, [4, -4], [40, 40])).toEqual([4, -4]);
      expect(x).toEqual([0, 0, 0]);
    }
  });

  it('uses EVO recording frame evidence instead of the shared 0.8.2 version', () => {
    const header = { ...sample.header, game: 'acevo', recorder };
    expect(planarLeftSign(header)).toBeNull();
    expect(planarLeftSign({ ...header, recorder: { ...recorder, coordinateFrame: 'acevo-original-x-v1' } })).toBe(1);
    expect(planarLeftSign({ ...header, recorder: { ...recorder, coordinateFrame: 'acevo-reflected-x-v1' } })).toBe(-1);
    expect(planarLeftSign({ ...header, recorder: { ...recorder, build: '9c36958', coordinateFrame: 'future-frame' } })).toBeNull();
  });

  it('does not assume a future frame keeps today’s AC handedness', () => {
    expect(planarLeftSign({ ...sample.header, game: 'ac', recorder: { ...recorder, source: 'ac', coordinateFrame: 'future-ac' } })).toBeNull();
  });

  it('keeps position-only corner directions after converting the same physical lap to AC coordinates', () => {
    const withoutSteer = buildSyntheticLap({ lengthM: 4200, corners: exampleCorners(), channels: ['t', 'dist', 'speed', 'x', 'z'] }).lap;
    const project = detectCorners(withoutSteer).map((corner) => corner.direction);
    const ac = { ...withoutSteer, header: { ...withoutSteer.header, game: 'ac' }, data: { ...withoutSteer.data, x: withoutSteer.data.x.map((x) => -x) } };
    expect(project[0]).toBe('right');
    expect(detectCorners(ac).map((corner) => corner.direction)).toEqual(project);
  });
});
