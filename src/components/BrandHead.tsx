// Mutates document.head whenever the active brand config changes so that the
// favicon, theme-color, OG and Twitter share images all reflect the admin's
// uploaded brand without requiring a redeploy. Mounted once in App.tsx.

import { useEffect } from 'react';
import { useBrand } from '@/hooks/use-brand';

function setOrCreateLink(rel: string, href: string, attrs: Record<string, string> = {}): void {
  let el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
}

function setOrCreateMeta(selector: string, attr: 'name' | 'property', key: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

export default function BrandHead() {
  const brand = useBrand();

  useEffect(() => {
    // Favicon — prefer 32x32 PNG when custom, fall back to bundled .ico
    if (brand.icon_32_url && brand.icon_32_url !== '/favicon.ico') {
      setOrCreateLink('icon', brand.icon_32_url, { type: 'image/png' });
    } else {
      setOrCreateLink('icon', brand.logo_url, { type: 'image/svg+xml' });
    }

    // Apple touch icon (180x180) — install-to-homescreen on iOS
    setOrCreateLink('apple-touch-icon', brand.icon_180_url);

    // Theme color (mobile browser chrome + PWA splash)
    setOrCreateMeta('meta[name="theme-color"]', 'name', 'theme-color', brand.theme_color);

    // OG + Twitter share image
    setOrCreateMeta('meta[property="og:image"]', 'property', 'og:image', brand.og_image_url);
    setOrCreateMeta('meta[name="twitter:image"]', 'name', 'twitter:image', brand.og_image_url);
  }, [brand]);

  return null;
}
