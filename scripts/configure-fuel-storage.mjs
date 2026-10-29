// Run: node --env-file=.env scripts/configure-fuel-storage.mjs
import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bucket = await db.storage.getBucket('vehicle-fuel-records');
if (!bucket.data) {
  if (bucket.error?.message !== 'Bucket not found' && Number(bucket.error?.statusCode) !== 404) throw bucket.error;
  const created = await db.storage.createBucket('vehicle-fuel-records', { public: false, fileSizeLimit: 16384, allowedMimeTypes: ['application/json'] });
  if (created.error) throw created.error;
} else if (bucket.data.public) throw Error('Fuel records bucket must be private');
console.log('Private fuel-record storage is ready.');
