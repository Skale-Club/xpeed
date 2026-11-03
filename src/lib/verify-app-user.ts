import { createClient } from '@supabase/supabase-js';

/** The Data API verifies JWT signatures and the registered issuer before mapping the UID. */
export async function verifyAppUser(url: string, key: string, token: string): Promise<string | null> {
  const scoped = createClient(url,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error} = await scoped.rpc('current_app_user_id');
  return !error && typeof data === 'string' && data ? data : null;
}
