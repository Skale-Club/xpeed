// What a VIN (chassis number) says about a car. The 17-character VIN is a
// worldwide standard (ISO 3779): the first 3 characters name the maker and
// the country it was built in, the 10th the model year. That part works for
// any country and offline. Model and fuel come from NHTSA's database, which is
// complete for cars sold in the US and partial elsewhere (e.g. Brazil), so
// they may be missing and the owner fills them in.

import { decodeVin } from '@/lib/vin-decoder';
import type { EngineType } from '@/lib/db';

export function isValidVin(vin: string | null | undefined): vin is string {
  return !!vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin.trim().toUpperCase());
}

// World manufacturer identifiers (first 3 characters, or 2 for big makers)
// of the brands most common in Brazil, the US and Latin America.
const WMI: Record<string, string> = {
  // Brazil
  '9BW': 'Volkswagen', '9BG': 'Chevrolet', '9BD': 'Fiat', '9BR': 'Toyota', '93H': 'Honda', '9BH': 'Hyundai',
  '9BF': 'Ford', '93Y': 'Renault', '94D': 'Nissan', '98R': 'Jeep', '988': 'Jeep', '936': 'Peugeot', '935': 'Citroën',
  '9BM': 'Mercedes-Benz', '9C2': 'Honda', '9BS': 'Scania', '953': 'Volkswagen', '93X': 'Mitsubishi', '95P': 'CAOA Chery',
  // Argentina / Mexico
  '8AF': 'Ford', '8AG': 'Chevrolet', '8AJ': 'Toyota', '8AP': 'Fiat', '8AW': 'Volkswagen', '3VW': 'Volkswagen',
  '3N1': 'Nissan', '3FA': 'Ford', '3G1': 'Chevrolet', '3HG': 'Honda', 'MR0': 'Toyota',
  // US / Canada
  '1HG': 'Honda', '2HG': 'Honda', '5FN': 'Honda', '19X': 'Honda', '1FA': 'Ford', '1FT': 'Ford', '1FM': 'Ford',
  '1G1': 'Chevrolet', '1GC': 'Chevrolet', '2G1': 'Chevrolet', '1C4': 'Jeep', '1J4': 'Jeep', '1N4': 'Nissan',
  '4T1': 'Toyota', '4T3': 'Toyota', '5TD': 'Toyota', '5YJ': 'Tesla', '2T1': 'Toyota', '2T3': 'Toyota',
  // Asia / Europe
  JT: 'Toyota', JH: 'Honda', JN: 'Nissan', JM: 'Mazda', JF: 'Subaru', JA: 'Mitsubishi', KM: 'Hyundai', KN: 'Kia',
  WVW: 'Volkswagen', WV2: 'Volkswagen', WBA: 'BMW', WDD: 'Mercedes-Benz', WAU: 'Audi', VF1: 'Renault', VF3: 'Peugeot',
  ZFA: 'Fiat', YV1: 'Volvo', SAL: 'Land Rover',
};

/** Maker from the VIN's first characters, or null when the code isn't in the table. */
export function vinMake(vin: string): string | null {
  const v = vin.toUpperCase();
  return WMI[v.slice(0, 3)] ?? WMI[v.slice(0, 2)] ?? null;
}

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

/**
 * Model year from the 10th character. The code repeats every 30 years
 * (A = 1980 or 2010), so the most recent year not in the future is taken.
 */
export function vinYear(vin: string, now = new Date()): number | null {
  const i = YEAR_CODES.indexOf(vin.toUpperCase()[9]);
  if (i < 0) return null;
  const latest = now.getFullYear() + 1;
  let year = 1980 + i;
  while (year + 30 <= latest) year += 30;
  return year;
}

export interface CarIdentity {
  vin: string;
  make: string | null;
  model: string | null;
  year: number | null;
  trim: string | null;
  engineType: EngineType | null;
}

/** Everything we can tell about a VIN: NHTSA when it knows the car, the offline table otherwise. */
export async function identifyVin(vin: string): Promise<CarIdentity> {
  const v = vin.trim().toUpperCase();
  const offline: CarIdentity = { vin: v, make: vinMake(v), model: null, year: vinYear(v), trim: null, engineType: null };
  const online = await decodeVin(v);
  if (!online) return offline;
  return {
    vin: v,
    make: online.make ? titleCase(online.make) : offline.make,
    model: online.model,
    year: online.year ?? offline.year,
    trim: online.trim,
    engineType: online.engineType,
  };
}

/** NHTSA writes makes in capitals ("TOYOTA"). */
function titleCase(s: string): string {
  return s.length <= 3 ? s : s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Could this VIN be this car? (Same maker and year, when both are known.) */
export function vinFitsCar(identity: CarIdentity, car: { make: string | null; year: number | null }): boolean {
  const sameMake = !identity.make || !car.make || identity.make.toLowerCase() === car.make.toLowerCase();
  const sameYear = !identity.year || !car.year || Math.abs(identity.year - car.year) <= 1;
  return sameMake && sameYear;
}
