/**
 * The channels every lap file may carry, with the one unit each is stored in.
 * Units are SI-ish on purpose: a lap recorded from any game is compared with a
 * lap from any other, so Xpeed Sim converts to these units before writing
 * (km/h becomes m/s, degrees stay out of the file, and so on).
 *
 * `t` and `dist` are required in every file. `dist` is the distance driven since
 * the start of the lap: laps are compared by where on the track the car is, not by
 * the clock. Games may add channels of their own with any other id (lowercase
 * letters, digits and underscores); those carry whatever unit Xpeed Sim states.
 */
export const STANDARD_CHANNELS = {
  t: { unit: 's', description: 'Time since the start of the lap' },
  dist: { unit: 'm', description: 'Distance driven since the start of the lap' },
  speed: { unit: 'm/s', description: 'Speed over the ground' },
  rpm: { unit: 'rpm', description: 'Engine speed' },
  gear: { unit: 'gear', description: 'Gear: -1 reverse, 0 neutral, 1 and up' },
  throttle: { unit: 'ratio', description: 'Throttle pedal, 0 to 1' },
  brake: { unit: 'ratio', description: 'Brake pedal, 0 to 1' },
  clutch: { unit: 'ratio', description: 'Clutch pedal, 0 to 1' },
  steer: { unit: 'ratio', description: 'Steering, -1 full left to 1 full right' },
  x: { unit: 'm', description: 'World position, east' },
  y: { unit: 'm', description: 'World position, up' },
  z: { unit: 'm', description: 'World position, north' },
  fuel: { unit: 'l', description: 'Fuel in the tank' },
} as const;

export type StandardChannelId = keyof typeof STANDARD_CHANNELS;

/** Channels a file must have to be useful: the clock and the position along the lap. */
export const REQUIRED_CHANNELS: readonly StandardChannelId[] = ['t', 'dist'];

export function standardUnit(id: string): string | null {
  return Object.prototype.hasOwnProperty.call(STANDARD_CHANNELS, id) ? STANDARD_CHANNELS[id as StandardChannelId].unit : null;
}
