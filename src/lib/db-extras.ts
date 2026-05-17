// Extra database helpers for new features (Phase 03+):
// - Maintenance log
// - Session photos
// - Shared reports
// - Dashboard stats RPC
// - Baselines refresh RPC

import { supabase } from '@/integrations/supabase/client';

// ---------- Maintenance ----------

export type MaintenanceType =
  | 'oil_change' | 'coolant_flush' | 'brake_pads_front' | 'brake_pads_rear'
  | 'brake_fluid' | 'transmission_fluid' | 'air_filter' | 'cabin_filter'
  | 'spark_plugs' | 'battery_12v' | 'battery_hv' | 'tires' | 'tire_rotation'
  | 'wheel_alignment' | 'timing_belt' | 'serpentine_belt' | 'inspection' | 'other';

export interface MaintenanceEvent {
  id: string;
  car_profile_id: string;
  user_id: string | null;
  event_type: MaintenanceType;
  performed_at: string;       // ISO date (YYYY-MM-DD)
  odometer_km: number | null;
  cost: number | null;
  currency: string | null;
  shop: string | null;
  notes: string | null;
  created_at: string;
}

export type MaintenanceInput = Omit<MaintenanceEvent, 'id' | 'user_id' | 'created_at'>;

export async function listMaintenanceEvents(carProfileId: string): Promise<MaintenanceEvent[]> {
  const { data, error } = await supabase
    .from('maintenance_events' as never)
    .select('*')
    .eq('car_profile_id', carProfileId)
    .order('performed_at', { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as MaintenanceEvent[];
}

export async function createMaintenanceEvent(input: MaintenanceInput): Promise<MaintenanceEvent> {
  const { data, error } = await supabase
    .from('maintenance_events' as never)
    .insert(input as never)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as MaintenanceEvent;
}

export async function deleteMaintenanceEvent(id: string): Promise<void> {
  const { error } = await supabase
    .from('maintenance_events' as never)
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ---------- Session Photos ----------

export type PhotoType = 'dashboard' | 'scanner' | 'engine_bay' | 'other';

export interface SessionPhoto {
  id: string;
  session_id: string;
  storage_path: string;
  caption: string | null;
  photo_type: PhotoType | null;
  created_at: string;
}

const PHOTO_BUCKET = 'session-photos';

export async function uploadSessionPhoto(
  file: File,
  sessionId: string,
  photoType: PhotoType = 'other',
  caption?: string,
): Promise<SessionPhoto> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('User not authenticated');

  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${user.id}/${sessionId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('session_photos' as never)
    .insert({
      session_id: sessionId,
      storage_path: path,
      photo_type: photoType,
      caption: caption ?? null,
    } as never)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as SessionPhoto;
}

export async function listSessionPhotos(sessionId: string): Promise<SessionPhoto[]> {
  const { data, error } = await supabase
    .from('session_photos' as never)
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as unknown as SessionPhoto[];
}

export function getPhotoUrl(storagePath: string): string {
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

export async function deleteSessionPhoto(photo: SessionPhoto): Promise<void> {
  await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);
  await supabase.from('session_photos' as never).delete().eq('id', photo.id);
}

// ---------- Shared Reports ----------

export interface SharedReport {
  id: string;
  session_id: string;
  user_id: string;
  expires_at: string | null;
  view_count: number;
  created_at: string;
}

export async function createSharedReport(sessionId: string, expiresInDays: number | null = 30): Promise<SharedReport> {
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const { data, error } = await supabase
    .from('shared_reports' as never)
    .insert({ session_id: sessionId, expires_at: expiresAt } as never)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as SharedReport;
}

export async function getSharedReport(reportId: string): Promise<Record<string, unknown> | null> {
  // RPC bypasses RLS to allow anon reads of shared links.
  const { data, error } = await supabase
    .rpc('get_shared_report' as never, { p_id: reportId } as never);
  if (error) {
    console.error('Failed to fetch shared report:', error);
    return null;
  }
  return data as Record<string, unknown> | null;
}

// ---------- Dashboard Stats RPC ----------

export interface DashboardStatsResult {
  totalSessions: number;
  totalDurationSeconds: number;
  healthScore: number;
  totalAttention: number;
  totalCritical: number;
  lastUpload: string | null;
  activeDtcs: string[];
  status: 'Excellent' | 'Good' | 'Attention' | 'Critical';
  trendData: Array<{ id: string; date_label: string; attention: number; critical: number; score: number }>;
}

export async function getDashboardStats(
  carProfileId: string,
  dateFrom?: Date,
): Promise<DashboardStatsResult | null> {
  const params: Record<string, string> = { p_car_profile_id: carProfileId };
  if (dateFrom) params.p_date_from = dateFrom.toISOString();

  const { data, error } = await supabase
    .rpc('get_dashboard_stats' as never, params as never);
  if (error) {
    console.error('Failed to fetch dashboard stats:', error);
    return null;
  }
  return data as unknown as DashboardStatsResult | null;
}

// ---------- Baselines ----------

export async function refreshParameterBaselines(carProfileId: string): Promise<void> {
  const { error } = await supabase
    .rpc('refresh_parameter_baselines' as never, { p_car_profile_id: carProfileId } as never);
  if (error) {
    console.warn('Baseline refresh failed (non-fatal):', error);
  }
}

export interface ParameterBaseline {
  id: string;
  car_profile_id: string;
  canonical_key: string;
  window_days: 7 | 30 | 90;
  mean: number;
  stddev: number;
  sample_count: number;
  computed_at: string;
}

export async function getParameterBaselines(carProfileId: string): Promise<ParameterBaseline[]> {
  const { data, error } = await supabase
    .from('parameter_baselines' as never)
    .select('*')
    .eq('car_profile_id', carProfileId);
  if (error) {
    console.warn('Failed to fetch baselines:', error);
    return [];
  }
  return (data || []) as unknown as ParameterBaseline[];
}
