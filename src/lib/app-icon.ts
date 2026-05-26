import { supabase } from '@/integrations/supabase/client';
import { upsertAdminSetting } from './db-extras';

export const ICON_BUCKET = 'app-icons';
export const ICON_SETTING_KEY = 'admin_app_icon_url';

export const ICON_SIZES = [
  { name: 'icon-192.png', width: 192, height: 192 },
  { name: 'icon-512.png', width: 512, height: 512 },
  { name: 'apple-touch-icon.png', width: 180, height: 180 },
] as const;

async function resizeToBlob(file: File, width: number, height: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('No 2D canvas context'));
        return;
      }
      // White background so transparent PNGs/SVGs look correct
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(objectUrl);
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob returned null'));
        },
        'image/png',
        0.95,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image for resizing'));
    };
    img.src = objectUrl;
  });
}

export async function uploadAppIcon(file: File): Promise<string> {
  await Promise.all(
    ICON_SIZES.map(async ({ name, width, height }) => {
      const blob = await resizeToBlob(file, width, height);
      const { error } = await supabase.storage
        .from(ICON_BUCKET)
        .upload(name, blob, { contentType: 'image/png', upsert: true });
      if (error) throw error;
    }),
  );

  const { data } = supabase.storage.from(ICON_BUCKET).getPublicUrl('icon-192.png');
  const baseUrl = data.publicUrl.replace('/icon-192.png', '');

  await upsertAdminSetting(ICON_SETTING_KEY, baseUrl);
  return baseUrl;
}

export async function getAppIconBaseUrl(): Promise<string | null> {
  const { data } = await (supabase
    .from('app_settings' as never)
    .select('setting_value')
    .eq('setting_key', ICON_SETTING_KEY)
    .is('user_id', null)
    .maybeSingle() as Promise<{ data: { setting_value: string | null } | null; error: unknown }>);
  return data?.setting_value ?? null;
}

export function buildIconUrl(baseUrl: string, filename: string): string {
  return `${baseUrl}/${filename}`;
}

export function applyFaviconToDocument(icon192Url: string, appleIconUrl: string): void {
  const favicon =
    (document.querySelector<HTMLLinkElement>('link[rel="icon"]') as HTMLLinkElement | null) ??
    (() => {
      const el = document.createElement('link');
      el.rel = 'icon';
      document.head.appendChild(el);
      return el;
    })();
  favicon.type = 'image/png';
  favicon.href = icon192Url;

  const apple =
    (document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]') as HTMLLinkElement | null) ??
    (() => {
      const el = document.createElement('link');
      el.rel = 'apple-touch-icon';
      document.head.appendChild(el);
      return el;
    })();
  apple.href = appleIconUrl;
}
