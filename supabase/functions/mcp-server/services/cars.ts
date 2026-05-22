import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CarProfile {
  id: string;
  name: string;
  notes: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
  engine_type: string | null;
  created_at: string;
}

const CAR_SELECT = "id, name, notes, make, model, year, vin, engine_type, created_at";

export async function listCars(client: SupabaseClient, userId?: string): Promise<CarProfile[]> {
  let query = client.from("car_profiles").select(CAR_SELECT);
  if (userId) query = query.eq("user_id", userId);
  query = query.order("created_at", { ascending: false });
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list cars: ${error.message}`);
  return data ?? [];
}

export async function getCar(client: SupabaseClient, id: string, userId?: string): Promise<CarProfile | null> {
  let query = client.from("car_profiles").select(CAR_SELECT).eq("id", id);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to get car: ${error.message}`);
  return data;
}
