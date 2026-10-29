// Run with: node --env-file=.env scripts/configure-trip-media.mjs
// No public buckets or anonymous storage policies are introduced.
import { createClient } from '@supabase/supabase-js';
const { VITE_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
if (!url || !key) throw new Error('Missing server-side storage credentials');
const db = createClient(url, key, { auth: { persistSession: false } });
const photos = await db.storage.getBucket('session-photos');
if (photos.error) throw photos.error;
const updated = await db.storage.updateBucket('session-photos', { public: false, fileSizeLimit: Math.max(25 * 1024 * 1024, photos.data.file_size_limit ?? 0), allowedMimeTypes: [...new Set([...(photos.data.allowed_mime_types ?? ['image/jpeg', 'image/png', 'image/webp', 'image/heic']), 'video/mp4', 'video/webm'])] });
if (updated.error) throw updated.error;
const manifests = await db.storage.getBucket('shared-trip-media');
if (!manifests.data) {
  if (Number(manifests.error?.statusCode) !== 404 && manifests.error?.message !== 'Bucket not found') throw manifests.error;
  const created = await db.storage.createBucket('shared-trip-media', { public: false, fileSizeLimit: 64 * 1024, allowedMimeTypes: ['application/json'] });
  if (created.error) throw created.error;
} else if (manifests.data.public) throw new Error('Manifest bucket must be private');
console.log('Trip media storage configured: private attachments and private link manifests.');
