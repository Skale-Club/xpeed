export type VolumeUnit = 'L' | 'US gal';
export type ConsumptionUnit = 'km/L' | 'L/100km' | 'MPG';
export type Currency = 'USD' | 'BRL' | 'EUR';
export const US_GALLON = 3.785411784;
export const litresPerUnit = (unit: VolumeUnit) => unit === 'US gal' ? US_GALLON : 1;
/** Stored metrics always stay in km/L; only their presentation changes. */
export function fuelEconomy(kmPerLitre: number | null | undefined, unit: ConsumptionUnit): number | null {
  if (kmPerLitre == null || !Number.isFinite(kmPerLitre) || kmPerLitre <= 0) return null;
  return unit === 'L/100km' ? 100 / kmPerLitre : unit === 'MPG' ? kmPerLitre * US_GALLON / 1.609344 : kmPerLitre;
}
export const economyLabel = (unit: ConsumptionUnit) => unit === 'MPG' ? 'MPG (US)' : unit;
