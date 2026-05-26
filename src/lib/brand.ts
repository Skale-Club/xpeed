// Brand asset pipeline — client-side image resizing + Supabase Storage upload.
//
// The super admin uploads ONE source image. This module derives every variant
// needed across the app (favicon, PWA icons, OG share image) and uploads each
// to the public `brand-assets` bucket. URLs are stored in app_settings as a
// single JSON blob under the `brand_config` key.

import { supabase } from '@/integrations/supabase/client';
import { upsertAdminSetting } from '@/lib/db-extras';

export const BRAND_CONFIG_KEY = 'brand_config';
export const BRAND_BUCKET = 'brand-assets';

// Target sizes. Square unless noted.
export const ICON_SIZES = [32, 180, 192, 512] as const;
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface BrandConfig {
  version: number;
  logo_url: string;          // Full vector if source was SVG; otherwise the largest PNG
  icon_32_url: string;
  icon_180_url: string;
  icon_192_url: string;
  icon_512_url: string;
  og_image_url: string;
  theme_color: string;       // hex #rrggbb
  background_color: string;
}

export const DEFAULT_BRAND: BrandConfig = {
  version: 0,
  logo_url: '/logo.svg',
  icon_32_url: '/favicon.ico',
  icon_180_url: '/favicon.ico',
  icon_192_url: '/favicon.ico',
  icon_512_url: '/favicon.ico',
  og_image_url: '/og-image-default.png',
  theme_color: '#141414',
  background_color: '#141414',
};

// --- Image loading + canvas helpers ---

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${e}`));
    img.src = src;
  });
}

export async function fileToObjectURL(file: File): Promise<{ url: string; isSvg: boolean }> {
  const isSvg = file.type === 'image/svg+xml';
  return { url: URL.createObjectURL(file), isSvg };
}

/** Resize to a square `size x size` canvas, contained (preserves aspect ratio). */
function renderSquare(img: HTMLImageElement, size: number, background: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);

  const ratio = Math.min(size / img.width, size / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  ctx.drawImage(img, x, y, w, h);
  return c;
}

/** Render OG 1200x630 — logo centered, theme-color letterbox fill. */
function renderOG(img: HTMLImageElement, background: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = OG_WIDTH;
  c.height = OG_HEIGHT;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, OG_WIDTH, OG_HEIGHT);

  // Logo target: ~50% of canvas height, centered
  const target = OG_HEIGHT * 0.5;
  const ratio = Math.min(target / img.width, target / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const x = (OG_WIDTH - w) / 2;
  const y = (OG_HEIGHT - h) / 2;
  ctx.drawImage(img, x, y, w, h);
  return c;
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null'))),
      type,
      quality,
    );
  });
}

// --- Upload pipeline ---

/** Upload a file/blob to brand-assets bucket, return public URL. */
async function uploadAndPublic(path: string, blob: Blob, contentType: string): Promise<string> {
  const { error } = await supabase.storage
    .from(BRAND_BUCKET)
    .upload(path, blob, { contentType, upsert: true, cacheControl: '3600' });
  if (error) throw new Error(`Upload ${path} failed: ${error.message}`);
  const { data } = supabase.storage.from(BRAND_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export interface BuildBrandInput {
  sourceFile: File;
  ogFile?: File | null;           // optional separate OG (1200x630). If absent, derived from source.
  themeColor: string;             // #rrggbb
  backgroundColor: string;
  previousVersion: number;        // last persisted version; we bump by 1
}

export interface BuildBrandResult extends BrandConfig {
  uploadedPaths: string[];
}

/**
 * End-to-end: validates source, renders every required variant, uploads each
 * to Supabase Storage, returns the new BrandConfig (NOT persisted to DB yet —
 * the caller is responsible for calling `saveBrandConfig`).
 */
export async function buildAndUploadBrand(input: BuildBrandInput): Promise<BuildBrandResult> {
  const { sourceFile, ogFile, themeColor, backgroundColor, previousVersion } = input;

  if (sourceFile.size > 2 * 1024 * 1024) {
    throw new Error('Source image is larger than 2 MB. Please use a smaller file.');
  }
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  if (!allowed.includes(sourceFile.type)) {
    throw new Error(`Unsupported format: ${sourceFile.type}. Use PNG / JPG / WebP / SVG.`);
  }

  const version = previousVersion + 1;
  const isSvg = sourceFile.type === 'image/svg+xml';
  const uploaded: string[] = [];

  const srcUrl = URL.createObjectURL(sourceFile);
  const img = await loadImage(srcUrl);

  // 1. logo_url — keep SVG vector if source is SVG; otherwise upload source as logo.png
  let logo_url: string;
  if (isSvg) {
    const path = `logo-${version}.svg`;
    logo_url = await uploadAndPublic(path, sourceFile, 'image/svg+xml');
    uploaded.push(path);
  } else {
    const path = `logo-${version}.png`;
    logo_url = await uploadAndPublic(path, sourceFile, sourceFile.type);
    uploaded.push(path);
  }

  // 2. PNG variants at each icon size
  const iconUrls: Record<number, string> = {};
  for (const size of ICON_SIZES) {
    const canvas = renderSquare(img, size, backgroundColor);
    const blob = await canvasToBlob(canvas, 'image/png');
    const path = `icon-${size}-${version}.png`;
    iconUrls[size] = await uploadAndPublic(path, blob, 'image/png');
    uploaded.push(path);
  }

  // 3. OG image — either from separate upload or derived from source
  let og_image_url: string;
  if (ogFile) {
    if (ogFile.size > 2 * 1024 * 1024) {
      throw new Error('OG image is larger than 2 MB.');
    }
    const ext = ogFile.type === 'image/png' ? 'png' : 'jpg';
    const path = `og-${version}.${ext}`;
    og_image_url = await uploadAndPublic(path, ogFile, ogFile.type);
    uploaded.push(path);
  } else {
    const canvas = renderOG(img, backgroundColor);
    const blob = await canvasToBlob(canvas, 'image/png');
    const path = `og-${version}.png`;
    og_image_url = await uploadAndPublic(path, blob, 'image/png');
    uploaded.push(path);
  }

  URL.revokeObjectURL(srcUrl);

  return {
    version,
    logo_url,
    icon_32_url: iconUrls[32],
    icon_180_url: iconUrls[180],
    icon_192_url: iconUrls[192],
    icon_512_url: iconUrls[512],
    og_image_url,
    theme_color: themeColor,
    background_color: backgroundColor,
    uploadedPaths: uploaded,
  };
}

// --- Persistence ---

export async function loadBrandConfig(): Promise<BrandConfig | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('setting_value')
    .is('user_id', null)
    .eq('setting_key', BRAND_CONFIG_KEY)
    .maybeSingle();

  if (error || !data?.setting_value) return null;
  try {
    return JSON.parse(data.setting_value) as BrandConfig;
  } catch {
    return null;
  }
}

export async function saveBrandConfig(config: BrandConfig): Promise<void> {
  // Strip non-persisted fields if present (uploadedPaths comes from BuildBrandResult)
  const { version, logo_url, icon_32_url, icon_180_url, icon_192_url, icon_512_url, og_image_url, theme_color, background_color } = config;
  const payload: BrandConfig = {
    version, logo_url, icon_32_url, icon_180_url, icon_192_url, icon_512_url, og_image_url, theme_color, background_color,
  };
  await upsertAdminSetting(BRAND_CONFIG_KEY, JSON.stringify(payload));
}

export async function clearBrandConfig(): Promise<void> {
  await upsertAdminSetting(BRAND_CONFIG_KEY, null);
}

// --- Preview helpers (used by admin UI before save) ---

export async function generateThumbnails(
  sourceFile: File,
  backgroundColor: string,
): Promise<{ size: number; dataUrl: string }[]> {
  const url = URL.createObjectURL(sourceFile);
  try {
    const img = await loadImage(url);
    return ICON_SIZES.map(size => {
      const canvas = renderSquare(img, size, backgroundColor);
      return { size, dataUrl: canvas.toDataURL('image/png') };
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
