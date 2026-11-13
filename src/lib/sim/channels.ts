/**
 * The channels every lap file may carry, with the one unit each is stored in.
 * Units are SI-ish on purpose: a lap recorded from any game is compared with a
 * lap from any other, so Xpeed Companion converts to these units before writing
 * (km/h becomes m/s, degrees stay out of the file, and so on).
 *
 * `t` and `dist` are required in every file. `dist` is the distance driven since
 * the start of the lap: laps are compared by where on the track the car is, not by
 * the clock. Games may add channels of their own with any other id (lowercase
 * letters, digits and underscores); those carry whatever unit Xpeed Companion states.
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
  // Added in format version 2. Each is present only when the game gives it (a column the game never gave is left
  // out, not filled with zeros), so a lap from one game can have all of them and a lap from another none. A tyre or a
  // wheel is named by its place: fl front left, fr front right, rl rear left, rr rear right.
  tyre_temp_fl: { unit: '°C', description: 'Front left tyre temperature' },
  tyre_temp_fr: { unit: '°C', description: 'Front right tyre temperature' },
  tyre_temp_rl: { unit: '°C', description: 'Rear left tyre temperature' },
  tyre_temp_rr: { unit: '°C', description: 'Rear right tyre temperature' },
  tyre_press_fl: { unit: 'kPa', description: 'Front left tyre pressure' },
  tyre_press_fr: { unit: 'kPa', description: 'Front right tyre pressure' },
  tyre_press_rl: { unit: 'kPa', description: 'Rear left tyre pressure' },
  tyre_press_rr: { unit: 'kPa', description: 'Rear right tyre pressure' },
  tyre_wear_fl: { unit: 'ratio', description: 'Front left tyre tread left, 1 new to 0 gone' },
  tyre_wear_fr: { unit: 'ratio', description: 'Front right tyre tread left, 1 new to 0 gone' },
  tyre_wear_rl: { unit: 'ratio', description: 'Rear left tyre tread left, 1 new to 0 gone' },
  tyre_wear_rr: { unit: 'ratio', description: 'Rear right tyre tread left, 1 new to 0 gone' },
  brake_temp_fl: { unit: '°C', description: 'Front left brake temperature' },
  brake_temp_fr: { unit: '°C', description: 'Front right brake temperature' },
  brake_temp_rl: { unit: '°C', description: 'Rear left brake temperature' },
  brake_temp_rr: { unit: '°C', description: 'Rear right brake temperature' },
  g_lat: { unit: 'g', description: 'Lateral acceleration of the car, positive toward its right (a right-hand corner)' },
  g_long: { unit: 'g', description: 'Longitudinal acceleration of the car, positive forward (accelerating)' },
  damage_body: { unit: 'ratio', description: 'Bodywork damage, 0 none to 1 destroyed' },
  drs: { unit: 'state', description: 'Rear wing (DRS): 0 not allowed, 1 allowed, 2 open' },
  tc_active: { unit: 'flag', description: 'Traction control is acting: 0 or 1' },
  abs_active: { unit: 'flag', description: 'ABS is acting: 0 or 1' },
} as const;

export type StandardChannelId = keyof typeof STANDARD_CHANNELS;

/** Channels a file must have to be useful: the clock and the position along the lap. */
export const REQUIRED_CHANNELS: readonly StandardChannelId[] = ['t', 'dist'];

export function standardUnit(id: string): string | null {
  return Object.prototype.hasOwnProperty.call(STANDARD_CHANNELS, id) ? STANDARD_CHANNELS[id as StandardChannelId].unit : null;
}
