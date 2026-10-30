import { expect, it } from 'vitest';
import { TripMotion } from './trip-motion';

it('distinguishes acceleration, steady speed and slowing using actual elapsed seconds', () => {
  const motion = new TripMotion();
  motion.update(0, 0);
  expect(motion.acceleration).toBeNull();
  motion.update(4, 14.4);
  expect(motion.acceleration).toBeCloseTo(1); // km/h → m/s, divided by seconds
  motion.update(8, 14.4);
  expect(motion.acceleration).toBe(0);
  motion.update(12, 0);
  expect(motion.acceleration).toBeCloseTo(-1);
});

it('smooths integer speed steps instead of treating each fast reply as a pedal movement', () => {
  const motion = new TripMotion();
  motion.update(0, 36);
  motion.update(0.1, 37);
  expect(motion.acceleration).toBeNull();
  motion.update(4, 37);
  expect(motion.acceleration).toBeCloseTo(1 / 3.6 / 4);
});

it('supports slow adapters but never bridges a Bluetooth gap or a missing reading', () => {
  const motion = new TripMotion();
  motion.update(0, 0); motion.update(8, 28.8);
  expect(motion.acceleration).toBeCloseTo(1);
  motion.update(30, 60);
  expect(motion.acceleration).toBeNull();
  motion.update(34, null); motion.update(38, 70);
  expect(motion.acceleration).toBeNull();
  motion.update(37, 71);
  expect(motion.acceleration).toBeNull();
  motion.update(42, Infinity);
  expect(motion.acceleration).toBeNull();
});
