import { afterEach, expect, it, vi } from 'vitest';
import manifest from '../../api/brand/manifest';
import { existsSync } from 'node:fs';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('keeps install-sized bundled icons when branding is unavailable', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'placeholder');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
  const response = await manifest(new Request('https://example.test/manifest.webmanifest'));
  const data = await response.json();
  expect(data.icons.some((icon: { sizes: string }) => icon.sizes === '192x192')).toBe(true);
  expect(data.icons.some((icon: { sizes: string }) => icon.sizes === '512x512')).toBe(true);
  for (const icon of data.icons) expect(existsSync(`public${icon.src}`)).toBe(true);
  expect(data.share_target).toBeUndefined(); // unsupported POST target would lose shared files
});
