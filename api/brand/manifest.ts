// Dynamic PWA manifest. Reads brand_config from app_settings and returns a
// manifest pointing at the admin-uploaded icons. Falls back to bundled assets
// when no brand_config row exists.
//
// Vercel rewrites /manifest.webmanifest → /api/brand/manifest so the URL the
// browser/PWA fetches stays the same.

export const config = { runtime: 'edge' };

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

async function fetchBrandConfig(supabaseUrl: string, anonKey: string): Promise<BrandConfig | null> {
  try {
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
  if (supabaseUrl && anonKey) {
    brand = await fetchBrandConfig(supabaseUrl, anonKey);
  }

  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? 'xpeed-skaleclub.vercel.app';
  const origin = `${proto}://${host}`;

  const themeColor = brand?.theme_color ?? DEFAULT_THEME;
  const backgroundColor = brand?.background_color ?? DEFAULT_THEME;

  const icons = brand
    ? [
        { src: brand.icon_192_url, sizes: '192x192', type: 'image/png' },
        { src: brand.icon_512_url, sizes: '512x512', type: 'image/png' },
        { src: brand.icon_512_url, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : [
        // Bundled fallback — the favicon.ico shipped with the build
        { src: `${origin}/favicon.ico`, sizes: '64x64 32x32 24x24 16x16', type: 'image/x-icon' },
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
    share_target: {
      action: '/import',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: { files: [{ name: 'csv', accept: ['text/csv', '.csv'] }] },
    },
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
