import { publicAppUrl } from '@/lib/trips';

export interface CarBrand {
  key: string;
  name: string;
  aliases: string[];
  logo: { type: string; sha256: string; bytes: number; path: string };
}

export function normalizeCarBrand(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function resolveCarBrand(make: string | null | undefined, brands: CarBrand[]): CarBrand | undefined {
  if (!make?.trim()) return undefined;
  const normalizedMake = normalizeCarBrand(make);
  return brands.find((brand) => [brand.key, brand.name, ...(Array.isArray(brand.aliases) ? brand.aliases : [])].some((alias) => typeof alias === 'string' && normalizeCarBrand(alias) === normalizedMake));
}

function isCarBrand(value: unknown): value is CarBrand {
  if (!value || typeof value !== 'object') return false;
  const brand = value as Partial<CarBrand>;
  return typeof brand.key === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(brand.key)
    && typeof brand.name === 'string' && brand.name.length > 0
    && Array.isArray(brand.aliases) && brand.aliases.every((alias) => typeof alias === 'string')
    && !!brand.logo && brand.logo.type === 'image/png'
    && typeof brand.logo.sha256 === 'string' && /^[a-f0-9]{64}$/.test(brand.logo.sha256)
    && typeof brand.logo.bytes === 'number' && Number.isFinite(brand.logo.bytes) && brand.logo.bytes > 0
    && typeof brand.logo.path === 'string';
}

export async function fetchCarBrands(): Promise<CarBrand[]> {
  const response = await fetch(`${publicAppUrl()}/api/car-brands`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Could not load car brands (${response.status})`);
  const payload = await response.json() as { brands?: CarBrand[] };
  if (!payload || !Array.isArray(payload.brands) || !payload.brands.every(isCarBrand)) throw new Error('Invalid car brand catalog');
  return payload.brands;
}

export function carBrandLogoUrl(brand: CarBrand): string {
  return `${publicAppUrl()}/api/car-brands/${encodeURIComponent(brand.key)}/logo?v=${encodeURIComponent(brand.logo.sha256)}`;
}
