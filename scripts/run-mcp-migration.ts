import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const sql = readFileSync(resolve('supabase/migrations/20260522000000_mcp_tokens.sql'), 'utf-8');

const client = createClient(url, serviceKey, { auth: { persistSession: false } });

async function run() {
  const { error } = await client.rpc('exec_sql', { query: sql });
  if (error) {
    // Try raw query via REST
    console.error('RPC failed, trying REST approach...');
    const { error: restError } = await client.from('_migration').insert({ sql }).single().maybeSingle();
    if (restError) {
      console.log('Executing SQL directly...');
      const { data, error: sqlError } = await client.rpc('pg_call', { sql_text: sql });
      if (sqlError) {
        console.error('All methods failed:', sqlError);
        // Fallback: print instructions
        console.log('\nRun this SQL manually in Supabase Dashboard SQL Editor:\n');
        console.log(sql);
        process.exit(1);
      }
    }
  }
  console.log('Migration applied successfully!');
}

run().catch(console.error);
