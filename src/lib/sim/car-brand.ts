import type { CarBrand } from '@/lib/car-brands';

function words(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// These short names are distinctive GT prototypes that omit the manufacturer in common sims.
// Keep this list deliberately small; unknown model-only names should stay generic.
const MODEL_BRANDS: Record<string, string> = { gr010: 'toyota', '499p': 'ferrari' };

export function resolveVirtualCarBrand(carName: string | null | undefined, brands: CarBrand[]): CarBrand | undefined {
  if (!carName?.trim()) return undefined;
  const name = words(carName);
  if (!name) return undefined;
  const modelKey = name.split(' ')[0];
  const modelBrand = MODEL_BRANDS[modelKey];
  if (modelBrand) {
    const brand = brands.find((item) => item.key === modelBrand);
    if (brand) return brand;
  }

  const candidates = brands.flatMap((brand) =>
    [brand.name, brand.key, ...brand.aliases].map((alias) => ({ brand, alias: words(alias) })),
  ).filter(({ alias }) => alias && (name === alias || name.startsWith(`${alias} `)));
  candidates.sort((a, b) => b.alias.length - a.alias.length);
  return candidates[0]?.brand;
}
