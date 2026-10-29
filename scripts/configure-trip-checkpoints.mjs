import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const current = await db.storage.getBucket('trip-checkpoints');
if (!current.data) {
  if (current.error?.message !== 'Bucket not found' && Number(current.error?.statusCode) !== 404) throw current.error;
  const saved = await db.storage.createBucket('trip-checkpoints', { public: false, fileSizeLimit: 256 * 1024, allowedMimeTypes: ['application/json'] });
  if (saved.error) throw saved.error;
} else if (current.data.public) throw Error('Trip checkpoints must be private');
console.log('Private cloud trip checkpoints ready.');
