// One rule for "is this a car's model year?", used wherever a year is typed.

export const MIN_CAR_YEAR = 1950;

/** Next year's models are already on sale. */
export const maxCarYear = (now: Date = new Date()) => now.getFullYear() + 1;

export function isValidCarYear(year: number, now: Date = new Date()): boolean {
  return Number.isInteger(year) && year >= MIN_CAR_YEAR && year <= maxCarYear(now);
}
