import { describe, expect, it } from 'vitest';
import { detectCorners, matchCorners, trackCorners, type Corner } from './corners';
import { MS_TO_KMH } from './lap-series';
import { buildSyntheticLap, exampleCorners, type SynthCorner, type SynthLap } from './synthetic-lap';

const LENGTH = 4200;
const kmh = (ms: number) => ms * MS_TO_KMH;

function track(options: { hz?: number; noise?: number; seed?: number; corners?: SynthCorner[]; channels?: Parameters<typeof buildSyntheticLap>[0]['channels']; samples?: number; lengthM?: number } = {}): SynthLap {
  return buildSyntheticLap({ lengthM: options.lengthM ?? LENGTH, corners: options.corners ?? exampleCorners(), hz: options.hz ?? 20, noise: options.noise ?? 0, seed: options.seed ?? 1, channels: options.channels, samples: options.samples });
}

/** The apex of each known corner: the chicane is one corner somewhere between its two minima. */
const KNOWN_APEXES = [520, 1040, undefined, 3100];

function expectKnownCorners(corners: Corner[], apexTolerance = 8) {
  expect(corners).toHaveLength(4);
  expect(corners.map((c) => c.index)).toEqual([1, 2, 3, 4]);
  corners.forEach((corner, i) => {
    const expected = KNOWN_APEXES[i];
    if (expected !== undefined) expect(Math.abs(corner.apexDist - expected)).toBeLessThanOrEqual(apexTolerance);
  });
  expect(corners[2].chicane).toBe(true);
  expect(corners[2].apexDist).toBeGreaterThan(1540);
  expect(corners[2].apexDist).toBeLessThan(1670);
  expect(corners.filter((c) => c.chicane)).toHaveLength(1);
}

describe('detecting corners', () => {
  it('finds exactly the known corners at 20 Hz', () => {
    expectKnownCorners(detectCorners(track({ hz: 20 }).lap));
  });

  it('finds exactly the known corners at 60 Hz', () => {
    expectKnownCorners(detectCorners(track({ hz: 60 }).lap));
  });

  it('finds the same corners with noise on every channel, at both sample rates', () => {
    for (const hz of [20, 60]) {
      for (const seed of [1, 2, 3]) expectKnownCorners(detectCorners(track({ hz, noise: 1, seed }).lap), 12);
    }
  });

  it('ignores gentle speed dips below the threshold', () => {
    // The track's 8 km/h dip is not a corner, and a lap of nothing but gentle dips has no corners at all.
    const dip: SynthCorner = { brakeDist: 500, apexDist: 540, exitDist: 580, entrySpeedKmh: 230, minSpeedKmh: 221, exitSpeedKmh: 224, gear: 5, turnInDist: 510, brakeEndDist: 530, pickupDist: 550, brakePeak: 0.2 };
    const dips = [dip, { ...dip, brakeDist: 1500, apexDist: 1540, exitDist: 1580, turnInDist: 1510, brakeEndDist: 1530, pickupDist: 1550 }];
    const lap = track({ corners: dips, noise: 1 }).lap;
    expect(detectCorners(lap)).toHaveLength(0);
    // The threshold is what decides it.
    expect(detectCorners(lap, { minDropKmh: 5 })).toHaveLength(2);
  });

  it('keeps a chicane as one corner', () => {
    const corners = detectCorners(track().lap);
    expect(corners[2].chicane).toBe(true);
    // Allowed no recovery between the two minima, the same lap has one more corner.
    const split = detectCorners(track().lap, { chicaneRecoveryKmh: 2 });
    expect(split).toHaveLength(5);
    expect(split.filter((c) => c.chicane)).toHaveLength(0);
  });

  it('merges minima closer than the minimum separation, and keeps corners apart that are further', () => {
    const close: SynthCorner[] = [
      { brakeDist: 400, apexDist: 480, exitDist: 495, entrySpeedKmh: 200, minSpeedKmh: 90, exitSpeedKmh: 120, turnInDist: 450, brakeEndDist: 470, pickupDist: 530, gear: 3 },
      { brakeDist: 500, apexDist: 520, exitDist: 560, entrySpeedKmh: 200, minSpeedKmh: 85, exitSpeedKmh: 120, turnInDist: 505, brakeEndDist: 515, pickupDist: 540, gear: 3 },
    ];
    const lap = track({ corners: close }).lap;
    expect(detectCorners(lap)).toHaveLength(1);
    expect(detectCorners(lap, { minSeparationM: 20, chicaneRecoveryKmh: 0 })).toHaveLength(2);
  });

  it('works with only speed', () => {
    const lap = track({ channels: ['t', 'dist', 'speed'] }).lap;
    const corners = detectCorners(lap);
    expectKnownCorners(corners);
    for (const corner of corners) {
      expect(corner.brakePointDist).toBeNull();
      expect(corner.brakePeak).toBeNull();
      expect(corner.brakeSource).toBeNull();
      expect(corner.trailBrakeLength).toBeNull();
      expect(corner.throttlePickupDist).toBeNull();
      expect(corner.direction).toBeNull();
      expect(corner.gear).toBeNull();
      expect(corner.timeInCorner).toBeGreaterThan(0);
      expect(corner.available).toEqual({ brake: false, throttle: false, steer: false, position: false });
    }
  });

  it('has no corners when there is no speed channel or the lap is empty', () => {
    expect(detectCorners(track({ channels: ['t', 'dist', 'brake'] }).lap)).toEqual([]);
    const flat = track({ corners: [] }).lap;
    expect(detectCorners(flat)).toEqual([]);
  });

  it('is deterministic', () => {
    const lap = track({ noise: 1, hz: 60 }).lap;
    expect(JSON.stringify(detectCorners(lap))).toBe(JSON.stringify(detectCorners(lap)));
  });
});

describe('what is measured in each corner', () => {
  for (const hz of [20, 60]) {
    it(`reads the brake point, minimum speed, exit speed, pickup distance and time in corner within tolerance at ${hz} Hz`, () => {
      const { lap, truth } = track({ hz, noise: hz === 60 ? 1 : 0 });
      const corners = detectCorners(lap);
      // The corners that have one braking zone and one pickup each: 1, 2 and 4 (the chicane is looked at below).
      const pairs: Array<[Corner, (typeof truth.corners)[number]]> = [[corners[0], truth.corners[0]], [corners[1], truth.corners[1]], [corners[3], truth.corners[5]]];
      for (const [corner, expected] of pairs) {
        expect(corner.brakePointDist).not.toBeNull();
        expect(Math.abs((corner.brakePointDist as number) - expected.brakeDist)).toBeLessThanOrEqual(4);
        expect(Math.abs(kmh(corner.minSpeed) - kmh(expected.minSpeed))).toBeLessThanOrEqual(2);
        expect(Math.abs((corner.throttlePickupDist as number) - expected.pickupDist)).toBeLessThanOrEqual(5);
        expect(Math.abs(kmh(corner.exitSpeed) - kmh(truth.speedAt(corner.endDist)))).toBeLessThanOrEqual(2);
        expect(Math.abs(kmh(corner.entrySpeed) - kmh(truth.speedAt(corner.startDist)))).toBeLessThanOrEqual(2);
        expect(Math.abs(corner.timeInCorner - (truth.timeAt(corner.endDist) - truth.timeAt(corner.startDist)))).toBeLessThanOrEqual(0.03);
        expect(corner.startDist).toBeGreaterThanOrEqual(expected.brakeDist - 5);
        expect(corner.startDist).toBeLessThanOrEqual(expected.brakeDist + 30);
        expect(corner.endDist).toBeGreaterThan(expected.apexDist);
        expect(corner.brakePeak as number).toBeGreaterThan(0.8);
        expect(corner.brakePeak as number).toBeLessThanOrEqual(1);
      }
    });
  }

  it('reads the brake, the pickup and the minimum of the chicane from its first braking zone to its last minimum', () => {
    const { lap, truth } = track();
    const chicane = detectCorners(lap)[2];
    expect(Math.abs((chicane.brakePointDist as number) - truth.corners[2].brakeDist)).toBeLessThanOrEqual(4);
    expect(Math.abs(chicane.throttlePickupDist as number - truth.corners[3].pickupDist)).toBeLessThanOrEqual(5);
    expect(kmh(chicane.minSpeed)).toBeCloseTo(98, 0);
  });

  it('reads the trail braking length, the direction and the gear', () => {
    const { lap, truth } = track();
    const corners = detectCorners(lap);
    expect(corners.map((c) => c.direction)).toEqual(['right', 'left', expect.stringMatching(/left|right/), 'left']);
    expect(corners.map((c) => c.gear)).toEqual([3, 2, 3, 3]);
    expect(Math.abs((corners[0].trailBrakeLength as number) - truth.corners[0].trailBrakeLength)).toBeLessThanOrEqual(6);
    expect(Math.abs((corners[1].trailBrakeLength as number) - truth.corners[1].trailBrakeLength)).toBeLessThanOrEqual(6);
    expect(corners[0].trailBrakeLength as number).toBeGreaterThan(10);
  });

  it('measures almost no trail braking when the brake is off before the steering comes on', () => {
    const lifted = exampleCorners().filter((_, i) => i !== 2 && i !== 3).map((c) => ({ ...c, turnInDist: c.apexDist - 25, brakeEndDist: c.apexDist - 24 }));
    const detected = detectCorners(buildSyntheticLap({ lengthM: LENGTH, corners: lifted }).lap).filter((c) => c.trailBrakeLength !== null);
    expect(detected.length).toBeGreaterThan(0);
    for (const corner of detected) expect(corner.trailBrakeLength as number).toBeLessThan(6);
  });

  it('takes the direction from the path when there is no steering channel', () => {
    const lap = track({ channels: ['t', 'dist', 'speed', 'x', 'z'] }).lap;
    const corners = detectCorners(lap);
    expect(corners.map((c) => c.direction)).toEqual(['right', 'left', expect.stringMatching(/left|right/), 'left']);
    expect(corners[0].available.position).toBe(true);
    expect(corners[0].available.steer).toBe(false);
  });

  it('infers the brake point from the deceleration when there is no brake channel', () => {
    const { lap, truth } = track({ channels: ['t', 'dist', 'speed', 'g_long', 'throttle'] });
    const corners = detectCorners(lap);
    expect(corners[1].brakeSource).toBe('g_long');
    expect(Math.abs((corners[1].brakePointDist as number) - truth.corners[1].brakeDist)).toBeLessThanOrEqual(5);
    expect(corners[1].brakePeak).toBeNull();
    expect(corners[1].trailBrakeLength).toBeNull();
  });

  it('prefers the brake channel over the deceleration when both exist', () => {
    const corners = detectCorners(track().lap);
    expect(corners.every((c) => c.brakeSource === 'brake')).toBe(true);
  });

  it('says the brake point is unknown rather than guessing it from speed alone', () => {
    const corners = detectCorners(track({ channels: ['t', 'dist', 'speed', 'throttle', 'steer'] }).lap);
    expect(corners.every((c) => c.brakePointDist === null && c.brakeSource === null)).toBe(true);
    expect(corners.every((c) => c.throttlePickupDist !== null)).toBe(true);
  });

  it('copes with samples the game did not give', () => {
    const { lap } = track({ hz: 60 });
    for (let i = 100; i < lap.data.speed.length; i += 97) lap.data.speed[i] = Number.NaN;
    for (let i = 50; i < lap.data.brake.length; i += 211) lap.data.brake[i] = Number.NaN;
    expectKnownCorners(detectCorners(lap));
  });
});

describe('detecting corners on a long lap', () => {
  it('detects corners on a 500,000-sample lap in under 1 second', () => {
    const { lap } = track({ samples: 500_000 });
    expect(lap.header.sampleCount).toBe(500_000);
    const started = performance.now();
    const corners = detectCorners(lap);
    const elapsed = performance.now() - started;
    expect(corners).toHaveLength(4);
    expect(elapsed).toBeLessThan(1000);
  }, 60_000);
});

describe('matching the corners of two laps', () => {
  const reference = () => detectCorners(track({ hz: 20 }).lap);

  it('pairs the corners of two laps of the same track one to one, in order', () => {
    const a = reference();
    const b = detectCorners(track({ hz: 60, noise: 1, seed: 9 }).lap);
    const match = matchCorners(a, b);
    expect(match.pairs.map((p) => [p.reference.index, p.other.index])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(match.unmatchedReference).toEqual([]);
    expect(match.unmatchedOther).toEqual([]);
    expect(match.pairs.every((p) => p.offsetM < 15)).toBe(true);
  });

  it('tolerates laps whose length differs by up to 3%', () => {
    const grow = 1.03;
    const longer = exampleCorners().map((c) => ({
      ...c,
      brakeDist: c.brakeDist * grow, apexDist: c.apexDist * grow, exitDist: c.exitDist * grow,
      turnInDist: c.turnInDist === undefined ? undefined : c.turnInDist * grow,
      brakeEndDist: c.brakeEndDist === undefined ? undefined : c.brakeEndDist * grow,
      pickupDist: c.pickupDist === undefined ? undefined : c.pickupDist * grow,
    }));
    const other = detectCorners(track({ corners: longer, lengthM: LENGTH * grow }).lap);
    expect(other).toHaveLength(4);
    const match = matchCorners(reference(), other);
    expect(match.pairs).toHaveLength(4);
    expect(match.unmatchedReference).toHaveLength(0);
    expect(match.unmatchedOther).toHaveLength(0);
  });

  it('does not match laps whose lengths differ by more than 3%', () => {
    const other = detectCorners(track({ lengthM: LENGTH * 1.05 }).lap);
    const match = matchCorners(reference(), other);
    expect(match.pairs).toEqual([]);
    expect(match.unmatchedReference).toHaveLength(4);
    expect(match.unmatchedOther).toHaveLength(4);
  });

  it('leaves a missing corner unmatched without pairing its neighbors wrongly', () => {
    const a = reference();
    const b = a.filter((c) => c.index !== 2);
    const match = matchCorners(a, b);
    expect(match.pairs.map((p) => [p.reference.index, p.other.index])).toEqual([[1, 1], [3, 3], [4, 4]]);
    expect(match.unmatchedReference.map((c) => c.index)).toEqual([2]);
    expect(match.unmatchedOther).toEqual([]);
  });

  it('leaves an extra corner unmatched, near a real one or far from all', () => {
    const a = reference();
    const far = { ...a[1], index: 99, apexFraction: 1300 / LENGTH };
    const near = { ...a[1], index: 98, apexFraction: a[1].apexFraction + 55 / LENGTH };
    const close = { ...a[1], index: 97, apexFraction: a[1].apexFraction + 30 / LENGTH };
    for (const extra of [far, near, close]) {
      const match = matchCorners(a, [...a, extra]);
      expect(match.pairs.map((p) => [p.reference.index, p.other.index])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
      expect(match.unmatchedOther.map((c) => c.index)).toEqual([extra.index]);
      expect(match.unmatchedReference).toEqual([]);
    }
  });

  it('copes with one lap having an extra corner and another a missing one at the same time', () => {
    const a = reference();
    const b = [...a.filter((c) => c.index !== 4), { ...a[0], index: 50, apexFraction: 2000 / LENGTH }];
    const match = matchCorners(a, b);
    expect(match.pairs.map((p) => p.reference.index)).toEqual([1, 2, 3]);
    expect(match.unmatchedReference.map((c) => c.index)).toEqual([4]);
    expect(match.unmatchedOther.map((c) => c.index)).toEqual([50]);
  });

  it('matches nothing when either lap has no corners', () => {
    const a = reference();
    expect(matchCorners(a, []).pairs).toEqual([]);
    expect(matchCorners([], a).unmatchedOther).toHaveLength(4);
  });
});

describe('the corners of a track from several laps', () => {
  it('gives one stable numbered list from many laps, at median positions', () => {
    const laps = [1, 2, 3, 4, 5].map((seed) => track({ noise: 1, seed, hz: seed % 2 ? 20 : 60 }).lap);
    const corners = trackCorners(laps);
    expect(corners).toHaveLength(4);
    expect(corners.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    expect(corners.every((c) => c.support === 5 && c.lapsUsed === 5)).toBe(true);
    expect(Math.abs(corners[0].apexDist - 520)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners[3].apexDist - 3100)).toBeLessThanOrEqual(10);
    expect(corners[0].direction).toBe('right');
    expect(corners[1].gear).toBe(2);
    expect(corners[0].brakePointDist as number).toBeGreaterThan(390);
    expect(corners[0].brakePointDist as number).toBeLessThan(410);
  });

  it('drops a corner that only a minority of the laps found, and keeps one that most found', () => {
    const full = [1, 2, 3].map((seed) => track({ seed }).lap);
    const missing = track({ corners: exampleCorners().filter((_, i) => i !== 5) }).lap;
    const twoOfFour = [...full, missing];
    expect(trackCorners(twoOfFour).map((c) => c.index)).toEqual([1, 2, 3, 4]);
    const mostlyMissing = [full[0], missing, missing, missing];
    const corners = trackCorners(mostlyMissing);
    expect(corners).toHaveLength(3);
    expect(trackCorners(mostlyMissing, { minSupport: 0.2 })).toHaveLength(4);
  });

  it('ignores laps whose length is not within 3% of the median', () => {
    const laps = [track().lap, track({ seed: 2 }).lap, track({ lengthM: LENGTH * 1.2 }).lap];
    const corners = trackCorners(laps);
    expect(corners.every((c) => c.lapsUsed === 2)).toBe(true);
    expect(trackCorners([])).toEqual([]);
  });
});
