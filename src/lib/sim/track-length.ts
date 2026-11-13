import { lengthIn, type DistanceUnit } from '@/lib/sim/analysis';

/** A track length in the person's unit: `5.79 km` or `3.60 mi`. */
export const trackLength = (meters: number, unit: DistanceUnit) => `${(lengthIn(meters, unit) / (unit === 'mi' ? 5280 : 1000)).toFixed(2)} ${unit === 'mi' ? 'mi' : 'km'}`;
