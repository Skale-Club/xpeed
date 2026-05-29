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

// SECURITY (S08-1): session-photos is a PRIVATE bucket. getPublicUrl() produced
// unsigned /object/public/ URLs that (a) 403 at runtime and (b) would leak every
// user's photos if the bucket were ever flipped public. Use short-lived signed
// URLs instead and keep the bucket private.
export async function getPhotoUrl(storagePath: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error) {
    console.error('Failed to sign photo URL:', error.message);
    return null;
  }
  return data?.signedUrl ?? null;
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

// ---------- Admin / system secrets ----------

/**
 * Returns true if the current authenticated user is an admin (has at least one
 * car_profile with is_admin = true). Uses the SECURITY DEFINER function so RLS
 * doesn't block the check.
 */
export async function isAdminUser(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin_user' as never);
  if (error) {
    console.warn('isAdminUser check failed:', error.message);
    return false;
  }
  return Boolean(data);
}

export interface AdminSetting {
  setting_key: string;
  setting_value: string | null;
  label: string;
  description: string;
  is_secret: boolean;
}

/**
 * The canonical list of admin-managed system settings. The UI iterates over
 * this and lets the admin set each value. Keep in sync with whatever the
 * Edge Functions actually read.
 */
export const KNOWN_ADMIN_SETTINGS: Omit<AdminSetting, 'setting_value'>[] = [
  {
    setting_key: 'admin_secret_gemini_api_key',
    label: 'Gemini API Key',
    description: 'Used by analyze-session and chat Edge Functions for AI features. Get one at aistudio.google.com.',
    is_secret: true,
  },
  {
    setting_key: 'admin_gemini_model',
    label: 'Default Gemini Model',
    description: 'Model used by analyze-session and chat Edge Functions. Default: gemini-2.5-flash.',
    is_secret: false,
  },
];

export async function listAdminSettings(): Promise<AdminSetting[]> {
  const keys = KNOWN_ADMIN_SETTINGS.map(s => s.setting_key);
  const { data, error } = await supabase
    .from('app_settings')
    .select('setting_key, setting_value')
    .is('user_id', null)
    .in('setting_key', keys);

  if (error) {
    console.error('Failed to load admin settings:', error);
    return KNOWN_ADMIN_SETTINGS.map(meta => ({ ...meta, setting_value: null }));
  }

  return KNOWN_ADMIN_SETTINGS.map(meta => {
    const row = (data || []).find((r) => r.setting_key === meta.setting_key);
    return { ...meta, setting_value: row?.setting_value ?? null };
  });
}

export async function upsertAdminSetting(settingKey: string, value: string | null): Promise<void> {
  // We upsert via two-step because Supabase upsert on partial unique indexes
  // is fiddly. Try update first; insert if not found.
  const { data: existing } = await supabase
    .from('app_settings')
    .select('id')
    .is('user_id', null)
    .eq('setting_key', settingKey)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('app_settings')
      .update({ setting_value: value })
      .eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('app_settings')
      .insert({ setting_key: settingKey, setting_value: value, encrypted: false, user_id: null });
    if (error) throw error;
  }
}

// ---------- Vehicle Issues ----------

export type IssueSeverity = 'attention' | 'critical' | 'info';
export type IssueStatus   = 'open' | 'monitoring' | 'resolved' | 'dismissed';

export interface VehicleIssue {
  id: string;
  car_profile_id: string;
  user_id: string;
  canonical_key: string | null;
  dtc_code: string | null;
  title: string;
  description: string | null;
  severity: IssueSeverity;
  status: IssueStatus;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

export type VehicleIssueInput = Pick<
  VehicleIssue,
  'car_profile_id' | 'title' | 'severity'
> & Partial<Pick<VehicleIssue, 'dtc_code' | 'description' | 'canonical_key'>>;

export type VehicleIssuePatch = Partial<Pick<
  VehicleIssue,
  'status' | 'severity' | 'title' | 'description' | 'resolution_note' | 'resolved_at'
>>;

export async function listVehicleIssues(carProfileId: string): Promise<VehicleIssue[]> {
  const { data, error } = await supabase
    .from('vehicle_issues' as never)
    .select('*')
    .eq('car_profile_id', carProfileId)
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as VehicleIssue[];
}

export async function createVehicleIssue(input: VehicleIssueInput): Promise<VehicleIssue> {
  const { data, error } = await supabase
    .from('vehicle_issues' as never)
    .insert(input as never)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as VehicleIssue;
}

export async function updateVehicleIssue(id: string, patch: VehicleIssuePatch): Promise<VehicleIssue> {
  const payload: VehicleIssuePatch & { resolved_at?: string | null } = { ...patch };
  if (patch.status === 'resolved' && !payload.resolved_at) {
    payload.resolved_at = new Date().toISOString();
  } else if (patch.status && patch.status !== 'resolved') {
    payload.resolved_at = null;
  }
  const { data, error } = await supabase
    .from('vehicle_issues' as never)
    .update(payload as never)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as VehicleIssue;
}

export async function deleteVehicleIssue(id: string): Promise<void> {
  const { error } = await supabase
    .from('vehicle_issues' as never)
    .delete()
    .eq('id', id);
  if (error) throw error;
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
