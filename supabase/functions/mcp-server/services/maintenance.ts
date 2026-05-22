import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface MaintenanceEvent {
  id: string;
  car_profile_id: string;
  event_type: string;
  performed_at: string;
  odometer_km: number | null;
  cost: number | null;
  currency: string | null;
  shop: string | null;
  notes: string | null;
  created_at: string;
}

const MAINT_SELECT = "id, car_profile_id, event_type, performed_at, odometer_km, cost, currency, shop, notes, created_at";

export async function listMaintenance(
  client: SupabaseClient,
  carProfileId: string,
  limit: number = 20,
  userId?: string,
): Promise<MaintenanceEvent[]> {
  let query = client.from("maintenance_events").select(MAINT_SELECT).eq("car_profile_id", carProfileId);
  if (userId) query = query.eq("user_id", userId);
  query = query.order("performed_at", { ascending: false }).limit(limit);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list maintenance: ${error.message}`);
  return data ?? [];
}
