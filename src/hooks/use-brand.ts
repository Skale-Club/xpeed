// Singleton subscription to the active brand config. Used everywhere a logo
// or themed color is rendered. Caches in localStorage for instant first paint
// on repeat visits — refreshed from DB once per app load.

import { useEffect, useState } from 'react';
import { loadBrandConfig, DEFAULT_BRAND, type BrandConfig } from '@/lib/brand';

const STORAGE_KEY = 'xpeed_brand_v1';

type Listener = (b: BrandConfig) => void;

let cached: BrandConfig | null = null;
let inflight: Promise<BrandConfig> | null = null;
const listeners = new Set<Listener>();

function readCache(): BrandConfig {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      cached = JSON.parse(raw) as BrandConfig;
      return cached;
    }
  } catch { /* ignore */ }
  cached = DEFAULT_BRAND;
  return cached;
}

function writeCache(b: BrandConfig): void {
  cached = b;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)); } catch { /* ignore */ }
  listeners.forEach(l => l(b));
}

async function refresh(): Promise<BrandConfig> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fromDb = await loadBrandConfig();
      const next = fromDb ?? DEFAULT_BRAND;
      writeCache(next);
      return next;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Force a re-fetch from DB (admin calls this after saving). */
export async function reloadBrand(): Promise<BrandConfig> {
  return refresh();
}

export function useBrand(): BrandConfig {
  const [brand, setBrand] = useState<BrandConfig>(() => readCache());

  useEffect(() => {
    listeners.add(setBrand);
    // Refresh from DB once on mount, but only if we haven't refreshed this load
    refresh().catch(() => { /* fall back silently to cached/default */ });
    return () => { listeners.delete(setBrand); };
  }, []);

  return brand;
}

/** Returns true if the active brand is the bundled default. */
export function isDefaultBrand(b: BrandConfig): boolean {
  return b.version === 0 || b.logo_url === DEFAULT_BRAND.logo_url;
}
