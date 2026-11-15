// The data client of the app. Everything goes through Xpeed's own server: tables and database
// functions (/api/db), files (/api/storage), edge functions (/api/fn) and change notices (polled
// from /api/db). Google Cloud owns the login session. Nothing here talks to Supabase any more,
// so the Supabase library is not part of the build; it only lends its types.
import type { SupabaseClient } from '@supabase/supabase-js';
import { apiData } from '@/lib/api-data';
import type { Database } from './types';

// Import the client like this:
// import { supabase } from "@/integrations/supabase/client";

// The calls the app makes (from, rpc, storage, functions, channel) have the same shape the typed
// client had, so every screen keeps its types.
export const supabase = apiData as unknown as SupabaseClient<Database>;
