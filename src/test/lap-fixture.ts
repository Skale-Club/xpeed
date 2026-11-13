// Test and screen-harness fixtures: two laps on a made-up track. Not part of the app.
import { STANDARD_CHANNELS, type StandardChannelId } from '@/lib/sim/channels';
import type { LapFile } from '@/lib/sim/lap-file';

/** The channels these sample laps carry: the ones of version 1 of the format. */
type SampleChannelId = Extract<StandardChannelId, 't' | 'dist' | 'speed' | 'rpm' | 'gear' | 'throttle' | 'brake' | 'clutch' | 'steer' | 'x' | 'y' | 'z' | 'fuel'>;

/**
 * Two laps on a made-up track, for trying the lap screens before there are laps recorded from a game.
 * The track is a closed curve; the speed along it follows the corners (a car can only turn so hard) and
 * the limits on braking and accelerating; the second lap brakes earlier and carries less speed through
 * the tightest corner, so it ends a little behind. Nothing here is random: the same laps every time.
 */

const TRACK_NAME = 'Sample Ring';
const SAMPLE_HZ = 50;
const LATERAL_ACCEL = 22; // m/s², what the tyres hold in a corner
const BRAKE_ACCEL = 17; // m/s²
const THROTTLE_ACCEL = 7.5; // m/s²
const TOP_SPEED = 84; // m/s, about 300 km/h

interface Track {
  /** Whole meters around: one entry per meter of track. */
  size: number;
  x: Float64Array;
  z: Float64Array;
  /** Signed curvature in 1/m (positive: turning toward +z from +x). */
  curvature: Float64Array;
}

function buildTrack(): Track {
  // A closed curve, drawn densely, then measured and resampled one point per meter.
  const dense = 8000;
  const px = new Float64Array(dense);
  const pz = new Float64Array(dense);
  for (let i = 0; i < dense; i++) {
    const a = (2 * Math.PI * i) / dense;
    px[i] = 520 * Math.cos(a) + 90 * Math.cos(3 * a);
    pz[i] = 280 * Math.sin(a) + 70 * Math.sin(2 * a);
  }
  const arc = new Float64Array(dense + 1);
  for (let i = 0; i < dense; i++) {
    const next = (i + 1) % dense;
    arc[i + 1] = arc[i] + Math.hypot(px[next] - px[i], pz[next] - pz[i]);
  }
  const length = arc[dense];
  const size = Math.floor(length);
  const x = new Float64Array(size);
  const z = new Float64Array(size);
  let j = 0;
  for (let k = 0; k < size; k++) {
    const target = (k * length) / size;
    while (j + 1 < dense && arc[j + 1] <= target) j++;
    const fraction = (target - arc[j]) / (arc[j + 1] - arc[j]);
    const next = (j + 1) % dense;
    x[k] = px[j] + (px[next] - px[j]) * fraction;
    z[k] = pz[j] + (pz[next] - pz[j]) * fraction;
  }
  const heading = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const [a, b] = [(k + size - 1) % size, (k + 1) % size];
    heading[k] = Math.atan2(z[b] - z[a], x[b] - x[a]);
  }
  const curvature = new Float64Array(size);
  const ds = length / size;
  for (let k = 0; k < size; k++) {
    let turn = heading[(k + 1) % size] - heading[(k + size - 1) % size];
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    curvature[k] = turn / (2 * ds);
  }
  return { size, x, z, curvature };
}

/** The speed to carry at each meter: the corner limit, then braking and accelerating limits around the loop. */
function speedProfile(track: Track, mistake: boolean): Float64Array {
  const { size, curvature } = track;
  const smooth = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    let sum = 0;
    for (let w = -15; w <= 15; w++) sum += Math.abs(curvature[(k + w + size) % size]);
    smooth[k] = sum / 31;
  }
  const v = new Float64Array(size);
  for (let k = 0; k < size; k++) v[k] = Math.min(TOP_SPEED, Math.sqrt(LATERAL_ACCEL / Math.max(smooth[k], 1e-4)));

  if (mistake) {
    // Less speed through the tightest corner.
    let tightest = 0;
    for (let k = 1; k < size; k++) if (smooth[k] > smooth[tightest]) tightest = k;
    for (let w = -70; w <= 70; w++) v[(tightest + w + size) % size] *= 0.93;
  }

  for (let pass = 0; pass < 3; pass++) {
    for (let k = size - 1; k >= 0; k--) {
      const ahead = v[(k + 1) % size];
      v[k] = Math.min(v[k], Math.sqrt(ahead * ahead + 2 * BRAKE_ACCEL));
    }
    for (let k = 0; k < size; k++) {
      const behind = v[k];
      const next = (k + 1) % size;
      v[next] = Math.min(v[next], Math.sqrt(behind * behind + 2 * THROTTLE_ACCEL));
    }
  }
  return v;
}

const GEAR_FROM = [0, 22, 38, 52, 66, 78];

function drive(track: Track, profile: Float64Array, lapNumber: number): LapFile {
  const { size } = track;
  const at = (array: Float64Array, s: number) => {
    const base = Math.floor(s);
    const f = s - base;
    return array[base % size] * (1 - f) + array[(base + 1) % size] * f;
  };
  const columns: Record<SampleChannelId, number[]> = {
    t: [], dist: [], speed: [], rpm: [], gear: [], throttle: [], brake: [], clutch: [], steer: [], x: [], y: [], z: [], fuel: [],
  };
  const dt = 1 / SAMPLE_HZ;
  let s = 0;
  let t = 0;
  const push = (distance: number, time: number) => {
    const speed = at(profile, distance);
    const accel = ((at(profile, distance + 1) - speed) * speed) / 1; // dv/dt = dv/ds * v, ds = 1 m
    const gear = 1 + GEAR_FROM.filter((from, i) => i > 0 && speed > from).length;
    const gearStart = GEAR_FROM[gear - 1];
    const gearEnd = GEAR_FROM[gear] ?? TOP_SPEED + 6;
    columns.t.push(time);
    columns.dist.push(distance);
    columns.speed.push(speed);
    columns.gear.push(gear);
    columns.rpm.push(4200 + (3800 * (speed - gearStart)) / (gearEnd - gearStart));
    columns.throttle.push(accel > -1 ? Math.min(1, 0.45 + accel / 6) : 0);
    columns.brake.push(accel < -2 ? Math.min(1, -accel / BRAKE_ACCEL) : 0);
    columns.clutch.push(0);
    columns.steer.push(Math.max(-1, Math.min(1, at(track.curvature, distance) * 70)));
    columns.x.push(at(track.x, distance));
    columns.y.push(0);
    columns.z.push(at(track.z, distance));
    columns.fuel.push(60 - 0.012 * time);
  };

  while (s < size) {
    push(s, t);
    s += at(profile, s) * dt;
    t += dt;
  }
  // The last sample sits exactly on the finish line.
  const speedAtEnd = at(profile, size - 1);
  const previous = columns.dist.length - 1;
  const lastT = columns.t[previous] + (size - columns.dist[previous]) / speedAtEnd;
  push(size, lastT);
  columns.x[columns.x.length - 1] = track.x[0];
  columns.z[columns.z.length - 1] = track.z[0];

  const ids = Object.keys(columns) as SampleChannelId[];
  return {
    header: {
      game: 'sample',
      track: { name: TRACK_NAME, lengthM: size },
      car: { name: 'Sample Car', class: 'Demo' },
      lap: { number: lapNumber, timeMs: Math.round(lastT * 1000), valid: true },
      startedAt: '2026-01-01T12:00:00.000Z',
      sampleRateHz: SAMPLE_HZ,
      sampleCount: columns.t.length,
      channels: ids.map((id) => ({ id, unit: STANDARD_CHANNELS[id].unit })),
    },
    data: Object.fromEntries(ids.map((id) => [id, Float32Array.from(columns[id])])),
  };
}

/** `[mine, best]`: a lap that loses a little time in the tightest corner, and the lap it is measured against. */
export function makeLapFixtures(): LapFile[] {
  const track = buildTrack();
  return [drive(track, speedProfile(track, true), 7), drive(track, speedProfile(track, false), 5)];
}
