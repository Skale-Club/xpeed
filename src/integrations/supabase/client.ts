// Database, storage and function client. Google Cloud owns the login session.
import { createClient } from '@supabase/supabase-js';
import { getAccessToken } from '@/lib/auth/google';
import { withApiData } from '@/lib/api-data';
import type { Database } from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

const client = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  // Identity Platform issues and refreshes the token; Supabase only consumes it.
  accessToken: getAccessToken,
});

// Leaving Supabase: with VITE_DATA_API=true, tables and database functions go through this
// app's own server (/api/db). Files, edge functions and realtime still use Supabase for now.
export const supabase = import.meta.env.VITE_DATA_API === 'true' ? withApiData(client) : client;
