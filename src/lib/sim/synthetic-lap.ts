import { STANDARD_CHANNELS, type StandardChannelId } from '@/lib/sim/channels';
import type { LapFile } from '@/lib/sim/lap-file';

/**
 * Made-up laps whose corners are known in advance, to test the analysis against: every position, speed and pedal
 * point is written down in the corner list, the channels are produced from it at any sample rate, and `truth` gives
 * back the exact clock and speed of the lap so a test can compare what the analysis found with what was put in.
 * Not used by the app. The speed along the lap is a function of distance: it climbs on the straights, holds the
 * entry speed until the brake point, falls to the apex speed, climbs to the exit speed, and goes on climbing.
 */

export interface SynthCorner {
  /** Where braking starts: the speed begins to fall here. */
  brakeDist: number;
  apexDist: number;
  /** Where the corner's own climb out of the apex ends. */
  exitDist: number;
  /** The speed held before the brake point (less if the straight before is too short to reach it). */
  entrySpeedKmh: number;
  minSpeedKmh: number;
  /** The speed at `exitDist`. */
  exitSpeedKmh: number;
  /** Where the throttle passes 0.5 (it rises from 0 to 1 over the 20 m around this). Default apex + 25. */
  pickupDist?: number;
  /** Hardest brake. Default 0.9. */
  brakePeak?: number;
  /** Where the steering starts to come on. Default apex - 35. */
  turnInDist?: number;
  /** Where the brake reaches 0 again (it trails off from the turn-in). Default apex - 5. */
  brakeEndDist?: number;
  /** Steering side and path: the car turns this way. Default right. */
  direction?: 'left' | 'right';
  /** Gear between the brake point and the exit. Default 3. */
  gear?: number;
  /** How far the path turns, degrees. Default 90. */
  turnDeg?: number;
  /** |steer| at the middle of the corner. Default 0.3. */
  steerPeak?: number;
}

export interface SynthLapOptions {
  lengthM: number;
  corners: SynthCorner[];
  /** Samples per second. Default 20. */
  hz?: number;
  /** Exactly this many samples instead (the rate follows from the lap time). */
  samples?: number;
  /** 0 for none; 1 is 0.2 m/s on speed, 0.01 on the pedals, 0.005 on the steering. Default 0. */
  noise?: number;
  seed?: number;
  /** The channels to write. Default: t, dist, speed, gear, throttle, brake, steer, x, z, g_long. */
  channels?: StandardChannelId[];
  startSpeedKmh?: number;
  /** How fast the car gains speed on a straight, in m/s per meter. Default 0.08. */
  accel?: number;
  trackName?: string;
  car?: string;
  game?: string;
  lapNumber?: number;
  valid?: boolean;
  inLap?: boolean;
  outLap?: boolean;
  sectorsMs?: number[];
}

export interface SynthTruthCorner {
  brakeDist: number;
  apexDist: number;
  /** m/s */
  minSpeed: number;
  pickupDist: number;
  /** Meters with the brake and the steering both on, at the default thresholds (0.1 and 0.04). */
  trailBrakeLength: number;
}

export interface SynthLap {
  lap: LapFile;
  truth: {
    lapTimeS: number;
    /** Seconds since the start of the lap at a distance. */
    timeAt(meters: number): number;
    /** m/s at a distance, without noise. */
    speedAt(meters: number): number;
    corners: SynthTruthCorner[];
  };
}

const KMH = 1 / 3.6;
const G = 9.81;
const FINE_STEP = 0.25;
export const DEFAULT_SYNTH_CHANNELS: StandardChannelId[] = ['t', 'dist', 'speed', 'gear', 'throttle', 'brake', 'steer', 'x', 'z', 'g_long'];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** 0 at u = 0, 1 at u = 1: straight except for a short rounding at the 0 end, so the apex is a smooth minimum. */
function ramp(u: number): number {
  const r = 0.12;
  const x = clamp(u, 0, 1);
  return (x < r ? (x * x) / (2 * r) : x - r / 2) / (1 - r / 2);
}

interface Spec {
  brake: number;
  apex: number;
  exit: number;
  entryV: number;
  apexV: number;
  exitV: number;
  pickup: number;
  peak: number;
  turnIn: number;
  brakeEnd: number;
  steerSign: number;
  gear: number;
  turnRad: number;
  steerPeak: number;
  entryEff: number;
}

export function buildSyntheticLap(options: SynthLapOptions): SynthLap {
  const { lengthM, accel = 0.08, noise = 0, seed = 1, channels = DEFAULT_SYNTH_CHANNELS } = options;
  const startV = (options.startSpeedKmh ?? 150) * KMH;
  const specs: Spec[] = [...options.corners]
    .sort((p, q) => p.brakeDist - q.brakeDist)
    .map((c) => ({
      brake: c.brakeDist,
      apex: c.apexDist,
      exit: c.exitDist,
      entryV: c.entrySpeedKmh * KMH,
      apexV: c.minSpeedKmh * KMH,
      exitV: c.exitSpeedKmh * KMH,
      pickup: c.pickupDist ?? c.apexDist + 25,
      peak: c.brakePeak ?? 0.9,
      turnIn: c.turnInDist ?? c.apexDist - 35,
      brakeEnd: c.brakeEndDist ?? c.apexDist - 5,
      steerSign: c.direction === 'left' ? -1 : 1,
      gear: c.gear ?? 3,
      turnRad: ((c.turnDeg ?? 90) * Math.PI) / 180,
      steerPeak: c.steerPeak ?? 0.3,
      entryEff: 0,
    }));
  specs.forEach((s, k) => {
    if (!(s.brake < s.turnIn && s.turnIn < s.brakeEnd && s.brakeEnd <= s.apex && s.apex < s.exit && s.pickup - 10 > s.brake + 3)) throw new Error(`Corner ${k + 1} has its points out of order.`);
    if (k > 0 && specs[k - 1].exit >= s.brake) throw new Error(`Corner ${k + 1} starts before the corner before it ends.`);
  });
  if (specs.length && specs[specs.length - 1].exit > lengthM) throw new Error('The last corner ends after the lap.');
  const top = Math.max(startV, ...specs.map((s) => s.entryV));
  let prevD = 0;
  let prevV = startV;
  for (const s of specs) {
    s.entryEff = Math.min(s.entryV, prevV + accel * (s.brake - prevD));
    prevD = s.exit;
    prevV = s.exitV;
  }

  const cornerAt = (d: number): number => {
    let lo = 0;
    let hi = specs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (specs[mid].brake <= d) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };

  const speedAt = (d: number): number => {
    const k = cornerAt(d);
    if (k < 0) return Math.min(specs.length ? specs[0].entryEff : top, startV + accel * d);
    const s = specs[k];
    if (d <= s.apex) return s.apexV + (s.entryEff - s.apexV) * ramp((s.apex - d) / (s.apex - s.brake));
    if (d <= s.exit) return s.apexV + (s.exitV - s.apexV) * ramp((d - s.apex) / (s.exit - s.apex));
    const ahead = k + 1 < specs.length ? specs[k + 1].entryEff : top;
    return Math.min(ahead, s.exitV + accel * (d - s.exit));
  };
  const brakeAt = (d: number): number => {
    const k = cornerAt(d);
    if (k < 0) return 0;
    const s = specs[k];
    if (d < s.brake || d >= s.brakeEnd) return 0;
    const on = Math.min(1, (d - s.brake) / 8);
    const trail = d <= s.turnIn ? 1 : Math.max(0, (s.brakeEnd - d) / (s.brakeEnd - s.turnIn));
    return s.peak * on * trail;
  };
  const throttleAt = (d: number): number => {
    const k = cornerAt(d);
    if (k < 0) return 1;
    const s = specs[k];
    if (d >= s.pickup + 10) return 1;
    return d < s.pickup - 10 ? clamp(1 - (d - s.brake) / 3, 0, 1) : clamp(0.5 + (d - s.pickup) / 20, 0, 1);
  };
  const steerAt = (d: number): number => {
    const k = cornerAt(d);
    if (k < 0) return 0;
    const s = specs[k];
    if (d < s.turnIn || d > s.exit) return 0;
    return s.steerSign * s.steerPeak * Math.sin((Math.PI * (d - s.turnIn)) / (s.exit - s.turnIn));
  };
  const gearAt = (d: number): number => {
    const k = cornerAt(d);
    return k >= 0 && d <= specs[k].exit ? specs[k].gear : 6;
  };
  const headingAt = (d: number): number => {
    let heading = 0;
    for (const s of specs) {
      const u = clamp((d - s.turnIn) / (s.exit - s.turnIn), 0, 1);
      // Right turns lower the heading (x east, z north: counter-clockwise is a left turn).
      heading -= s.steerSign * s.turnRad * u * u * (3 - 2 * u);
    }
    return heading;
  };

  // The lap on a fine grid of distances: the clock and the path come from integrating along it.
  const fineCount = Math.ceil(lengthM / FINE_STEP) + 1;
  const dF = new Float64Array(fineCount);
  const tF = new Float64Array(fineCount);
  const xF = new Float64Array(fineCount);
  const zF = new Float64Array(fineCount);
  for (let i = 0; i < fineCount; i++) dF[i] = Math.min(lengthM, i * FINE_STEP);
  for (let i = 1; i < fineCount; i++) {
    const a = dF[i - 1];
    const b = dF[i];
    const mid = (a + b) / 2;
    tF[i] = tF[i - 1] + (b - a) / speedAt(mid);
    const h = headingAt(mid);
    xF[i] = xF[i - 1] + Math.cos(h) * (b - a);
    zF[i] = zF[i - 1] + Math.sin(h) * (b - a);
  }
  const lapTimeS = tF[fineCount - 1];
  const timeAt = (meters: number): number => {
    const d = clamp(meters, 0, lengthM);
    const i = Math.min(fineCount - 2, Math.floor(d / FINE_STEP));
    const f = (d - dF[i]) / (dF[i + 1] - dF[i] || 1);
    return tF[i] + (tF[i + 1] - tF[i]) * clamp(f, 0, 1);
  };

  // The sample instants.
  let times: number[];
  if (options.samples) {
    const n = options.samples;
    times = Array.from({ length: n }, (_, k) => (k * lapTimeS) / (n - 1));
  } else {
    const dt = 1 / (options.hz ?? 20);
    times = [];
    for (let k = 0; k * dt < lapTimeS - 1e-9; k++) times.push(k * dt);
    times.push(lapTimeS);
  }
  const n = times.length;
  const hz = n > 1 ? (n - 1) / lapTimeS : 20;

  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const columns: Partial<Record<StandardChannelId, Float32Array>> = {};
  for (const id of channels) columns[id] = new Float32Array(n);
  const put = (id: StandardChannelId, i: number, value: number) => {
    const column = columns[id];
    if (column) column[i] = value;
  };
  const want = (id: StandardChannelId) => Boolean(columns[id]);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const ts = times[i];
    while (p < fineCount - 2 && tF[p + 1] <= ts) p++;
    const f = clamp((ts - tF[p]) / (tF[p + 1] - tF[p] || 1), 0, 1);
    const d = dF[p] + (dF[p + 1] - dF[p]) * f;
    put('t', i, ts);
    put('dist', i, d);
    if (want('speed')) put('speed', i, speedAt(d) + (noise ? noise * 0.2 * gauss() : 0));
    if (want('gear')) put('gear', i, gearAt(d));
    if (want('throttle')) put('throttle', i, clamp(throttleAt(d) + (noise ? noise * 0.01 * gauss() : 0), 0, 1));
    if (want('brake')) put('brake', i, clamp(brakeAt(d) + (noise ? noise * 0.01 * gauss() : 0), 0, 1));
    if (want('steer')) put('steer', i, steerAt(d) + (noise ? noise * 0.005 * gauss() : 0));
    if (want('x')) put('x', i, xF[p] + (xF[p + 1] - xF[p]) * f);
    if (want('z')) put('z', i, zF[p] + (zF[p + 1] - zF[p]) * f);
    if (want('y')) put('y', i, 0);
    if (want('g_long')) put('g_long', i, (speedAt(d) * (speedAt(d + 0.5) - speedAt(d - 0.5))) / G);
  }

  // What a perfect analysis finds for each corner.
  const truthCorners: SynthTruthCorner[] = specs.map((s) => {
    let trail = 0;
    for (let d = s.brake; d < s.brakeEnd; d += 0.1) if (brakeAt(d) >= 0.1 && Math.abs(steerAt(d)) >= 0.04) trail += 0.1;
    return { brakeDist: s.brake, apexDist: s.apex, minSpeed: s.apexV, pickupDist: s.pickup, trailBrakeLength: trail };
  });

  const data: Record<string, Float32Array> = {};
  for (const id of channels) data[id] = columns[id] as Float32Array;
  const lap: LapFile = {
    header: {
      game: options.game ?? 'lmu',
      track: { name: options.trackName ?? 'Synthetic Ring', lengthM },
      car: { name: options.car ?? 'Synthetic GT' },
      lap: {
        number: options.lapNumber ?? 1,
        timeMs: Math.round(lapTimeS * 1000),
        valid: options.valid ?? true,
        ...(options.sectorsMs ? { sectorsMs: options.sectorsMs } : {}),
        ...(options.inLap !== undefined ? { inLap: options.inLap } : {}),
        ...(options.outLap !== undefined ? { outLap: options.outLap } : {}),
      },
      startedAt: '2026-01-01T00:00:00.000Z',
      sampleRateHz: Math.round(hz),
      sampleCount: n,
      channels: channels.map((id) => ({ id, unit: STANDARD_CHANNELS[id].unit })),
    },
    data,
    version: 2,
  };
  return { lap, truth: { lapTimeS, timeAt, speedAt, corners: truthCorners } };
}

/**
 * A 4.2 km track with four real corners and a dip too gentle to count, for tests:
 * a medium right (1), a hairpin (2), a chicane of two close minima that is one corner (3, as 3a and 3b), a dip of 8 km/h, and a long left (4).
 */
export function exampleCorners(): SynthCorner[] {
  return [
    { brakeDist: 400, apexDist: 520, exitDist: 600, entrySpeedKmh: 220, minSpeedKmh: 110, exitSpeedKmh: 140, direction: 'right', gear: 3 },
    { brakeDist: 900, apexDist: 1040, exitDist: 1130, entrySpeedKmh: 230, minSpeedKmh: 70, exitSpeedKmh: 110, direction: 'left', gear: 2 },
    { brakeDist: 1450, apexDist: 1560, exitDist: 1585, entrySpeedKmh: 215, minSpeedKmh: 100, exitSpeedKmh: 102, turnInDist: 1530, direction: 'right', gear: 3, turnDeg: 30 },
    { brakeDist: 1605, apexDist: 1650, exitDist: 1700, entrySpeedKmh: 215, minSpeedKmh: 98, exitSpeedKmh: 130, turnInDist: 1625, brakeEndDist: 1640, direction: 'left', gear: 3, turnDeg: 30, pickupDist: 1670 },
    { brakeDist: 2500, apexDist: 2540, exitDist: 2580, entrySpeedKmh: 230, minSpeedKmh: 222, exitSpeedKmh: 224, direction: 'right', gear: 5, turnInDist: 2510, brakeEndDist: 2530, pickupDist: 2550, brakePeak: 0.2 },
    { brakeDist: 3000, apexDist: 3100, exitDist: 3180, entrySpeedKmh: 225, minSpeedKmh: 95, exitSpeedKmh: 130, direction: 'left', gear: 3 },
  ];
}

/** The same corners on a track `factor` times as long (every position scaled), for laps of slightly different length. */
export function scaleCorners(corners: SynthCorner[], factor: number): SynthCorner[] {
  const at = (meters: number | undefined) => (meters === undefined ? undefined : meters * factor);
  return corners.map((c) => ({
    ...c,
    brakeDist: c.brakeDist * factor, apexDist: c.apexDist * factor, exitDist: c.exitDist * factor,
    pickupDist: at(c.pickupDist), turnInDist: at(c.turnInDist), brakeEndDist: at(c.brakeEndDist),
  }));
}
