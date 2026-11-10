// Dynamic PWA manifest. Reads brand_config from app_settings and returns a
// manifest pointing at the admin-uploaded icons. Falls back to bundled assets
// when no brand_config row exists.
//
// The Node server exposes this handler at /manifest.webmanifest and /api/brand/manifest.

import { openBackend } from '../_backend';

interface BrandConfig {
  version: number;
  logo_url: string;
  icon_32_url: string;
  icon_180_url: string;
  icon_192_url: string;
  icon_512_url: string;
  og_image_url: string;
  theme_color: string;
  background_color: string;
}

const DEFAULT_THEME = '#141414';

async function fetchBrandConfig(supabaseUrl: string | undefined, anonKey: string | undefined): Promise<BrandConfig | null> {
  try {
    if (process.env.DATA_BACKEND === 'own') {
      // The app's own database: the public brand row, read with the server's own access.
      const own = openBackend();
      const row = await own?.service.from('app_settings').select('setting_value').eq('setting_key', 'brand_config').is('user_id', null).maybeSingle();
      const raw = (row?.data as { setting_value: string | null } | null)?.setting_value;
      return raw ? (JSON.parse(raw) as BrandConfig) : null;
    }
    if (!supabaseUrl || !anonKey) return null;
    const url = `${supabaseUrl}/rest/v1/app_settings?setting_key=eq.brand_config&user_id=is.null&select=setting_value`;
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ setting_value: string | null }>;
    const raw = rows?.[0]?.setting_value;
    if (!raw) return null;
    return JSON.parse(raw) as BrandConfig;
  } catch {
    return null;
  }
}

export default async function handler(req: Request): Promise<Response> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

  let brand: BrandConfig | null = null;
  brand = await fetchBrandConfig(supabaseUrl, anonKey);

  const themeColor = brand?.theme_color ?? DEFAULT_THEME;
  const backgroundColor = brand?.background_color ?? DEFAULT_THEME;

  const icons = brand
    ? [
        { src: brand.icon_192_url, sizes: '192x192', type: 'image/png' },
        { src: brand.icon_512_url, sizes: '512x512', type: 'image/png' },
        { src: brand.icon_512_url, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];

  const manifest = {
    name: 'Xpeed',
    short_name: 'Xpeed',
    description: 'OBD2 diagnostics with AI-powered insights',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: themeColor,
    background_color: backgroundColor,
    lang: 'en',
    icons,
    // A multipart POST share target needs a service-worker receiver. Do not
    // advertise /import while the app has no receiver or matching route.
  };

  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
