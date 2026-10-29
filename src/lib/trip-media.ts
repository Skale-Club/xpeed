export const MEDIA_TYPES: Record<string, { extension: string; maxBytes: number }> = {
  'image/jpeg': { extension: 'jpg', maxBytes: 10 * 1024 * 1024 },
  'image/png': { extension: 'png', maxBytes: 10 * 1024 * 1024 },
  'image/webp': { extension: 'webp', maxBytes: 10 * 1024 * 1024 },
  'video/mp4': { extension: 'mp4', maxBytes: 25 * 1024 * 1024 },
  'video/webm': { extension: 'webm', maxBytes: 25 * 1024 * 1024 },
};
export const isTripVideo = (path: string) => /\.(mp4|webm)$/i.test(path);
export interface SharedTripMedia { id: string; url: string; caption: string | null; photo_type: string | null; video: boolean }
