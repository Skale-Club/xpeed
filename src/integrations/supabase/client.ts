// Database, storage and function client. Google Cloud owns the login session.
import { createClient } from '@supabase/supabase-js';
import { getAccessToken } from '@/lib/auth/google';
import type { Database } from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  // Identity Platform issues and refreshes the token; Supabase only consumes it.
  accessToken: getAccessToken,
});
