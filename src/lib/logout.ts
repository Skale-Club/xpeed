import { supabase } from '@/integrations/supabase/client';
import { adminStatusCache } from '@/hooks/use-admin-status';
import type { QueryClient } from '@tanstack/react-query';

const USER_DATA_KEYS = ['selected_car_id'];

export async function logout(queryClient: QueryClient) {
  try { await supabase.auth.signOut(); } catch { /* ignore */ }

  Object.keys(localStorage)
    .filter(k => k.startsWith('sb-'))
    .forEach(k => localStorage.removeItem(k));
  USER_DATA_KEYS.forEach(k => localStorage.removeItem(k));
  sessionStorage.clear();

  adminStatusCache.clear();
  queryClient.clear();

  if ('caches' in window) {
    try { await caches.delete('share-target-v1'); } catch { /* ignore */ }
  }

  window.location.href = '/login';
}
