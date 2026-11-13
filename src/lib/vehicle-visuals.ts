import { publicAppUrl } from '@/lib/trips';

export interface VehicleVisual {
  key: string;
  make: string;
  model: string;
  modelAliases: string[];
  yearFrom: number;
  yearTo: number;
  modelPath: string | null;
  posterPath: string | null;
  credit: { author: string; sourceUrl: string; license: string; licenseUrl: string; changes: string };
}

let visualsPromise: Promise<VehicleVisual[]> | undefined;

export function normalizeVehicleName(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

export function findVehicleVisual(visuals: VehicleVisual[], car: { make?: string | null; model?: string | null; year?: number | null }): VehicleVisual | undefined {
  const make = normalizeVehicleName(car.make);
  const model = normalizeVehicleName(car.model);
  if (!make || !model || !Number.isInteger(car.year)) return undefined;
  return visuals.find((visual) => normalizeVehicleName(visual.make) === make
    && [visual.model, ...visual.modelAliases].some((name) => normalizeVehicleName(name) === model)
    && car.year! >= visual.yearFrom && car.year! <= visual.yearTo);
}

export function loadVehicleVisuals(): Promise<VehicleVisual[]> {
  visualsPromise ??= fetch(`${publicAppUrl()}/api/vehicle-visuals`, { signal: AbortSignal.timeout(5000) }).then(async (response) => {
    if (!response.ok) throw new Error('Vehicle visuals unavailable');
    const data = await response.json() as { visuals?: VehicleVisual[] };
    if (!Array.isArray(data.visuals) || !data.visuals.every(isVehicleVisual)) throw new Error('Invalid vehicle visual catalog');
    return data.visuals;
  }).catch((error) => {
    visualsPromise = undefined;
    throw error;
  });
  return visualsPromise;
}
function isVehicleVisual(value: unknown): value is VehicleVisual {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VehicleVisual>;
  const key = typeof item.key === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.key);
  const modelPath = item.modelPath === null || item.modelPath === `/vehicle-visuals/${item.key}.glb`;
  const posterPath = item.posterPath === null || item.posterPath === `/vehicle-visuals/${item.key}.png`;
  return !!key && typeof item.make === 'string' && !!item.make && typeof item.model === 'string' && !!item.model
    && Array.isArray(item.modelAliases) && item.modelAliases.every((alias) => typeof alias === 'string')
    && Number.isInteger(item.yearFrom) && Number.isInteger(item.yearTo) && item.yearFrom! <= item.yearTo!
    && modelPath && posterPath && !!item.credit && typeof item.credit.author === 'string'
    && typeof item.credit.sourceUrl === 'string' && /^https:\/\//.test(item.credit.sourceUrl)
    && typeof item.credit.license === 'string' && typeof item.credit.licenseUrl === 'string'
    && typeof item.credit.changes === 'string';
}

export function vehicleVisualAssetUrl(path: string): string {
  return `${publicAppUrl()}${path}`;
}
