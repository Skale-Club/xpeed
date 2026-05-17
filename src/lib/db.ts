import { supabase } from '@/integrations/supabase/client';

const SESSION_CSV_BUCKET = 'session-csv';
const SESSION_LIST_SELECT =
  'id, car_profile_id, uploaded_at, source_filename, source_file_path, session_start, session_end, duration_seconds, row_count, columns, summary, created_at, user_id, gemini_analysis';

function sanitizeFileName(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function ensureCsvExtension(filename: string): string {
  return filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
}

export async function getDefaultCarProfile() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('User not authenticated');
  }

  // Scope the lookup to the authenticated user — otherwise we may return another
  // user's car profile via the legacy "Allow all access" policy on row 0.
  const { data } = await supabase
    .from('car_profiles')
    .select('*')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (data) return data;

  const { data: newProfile, error: insertError } = await supabase
    .from('car_profiles')
    .insert({ name: '2010 Prius', notes: 'Toyota Prius Gen 3', user_id: user.id })
    .select()
    .single();
  if (insertError) throw insertError;
  return newProfile!;
}

export async function getSessions(carProfileId?: string) {
  let query = supabase
    .from('sessions')
    .select(SESSION_LIST_SELECT)
    .order('uploaded_at', { ascending: false });
  
  if (carProfileId) {
    query = query.eq('car_profile_id', carProfileId);
  }
  
  const { data } = await query;
  return data || [];
}

export async function getSession(id: string) {
  const { data } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return data;
}

export async function getSessionFlags(sessionId: string) {
  const { data } = await supabase
    .from('session_flags')
    .select('*')
    .eq('session_id', sessionId)
    .order('severity');
  return data || [];
}

export async function getFlagsForSessions(sessionIds: string[]) {
  if (sessionIds.length === 0) return [];
  const { data } = await supabase
    .from('session_flags')
    .select('*, sessions(source_filename, uploaded_at)')
    .in('session_id', sessionIds)
    .order('severity');
  return data || [];
}

export async function getSessionRows(sessionId: string) {
  const { data } = await supabase
    .from('session_rows')
    .select('*')
    .eq('session_id', sessionId)
    .order('t_seconds', { ascending: true })
    .limit(1000);
  return data || [];
}

export async function deleteSession(sessionId: string) {
  const { data: session, error: sessionReadError } = await supabase
    .from('sessions')
    .select('source_file_path')
    .eq('id', sessionId)
    .maybeSingle();

  if (sessionReadError) throw sessionReadError;

  const { error } = await supabase
    .from('sessions')
    .delete()
    .eq('id', sessionId);
  
  if (error) throw error;

  if (session?.source_file_path) {
    const { error: storageError } = await supabase.storage
      .from(SESSION_CSV_BUCKET)
      .remove([session.source_file_path]);

    if (storageError) {
      console.warn('Failed to remove session CSV from storage:', storageError.message);
    }
  }
}

export async function updateSession(sessionId: string, updates: Record<string, unknown>) {
  const { error } = await supabase
    .from('sessions')
    .update(updates as never)
    .eq('id', sessionId);

  if (error) throw error;
}

export async function createSession(
  carProfileId: string,
  filename: string,
  rowCount: number,
  columns: string[],
  summary: Record<string, unknown>,
  durationSeconds?: number,
  sessionStart?: string | null,
  sourceFilePath?: string | null,
  sourceCsv?: string | null,
) {
  const { data } = await supabase
    .from('sessions')
    .insert({
      car_profile_id: carProfileId,
      source_filename: filename,
      row_count: rowCount,
      columns: columns as unknown as never,
      summary: summary as unknown as never,
      duration_seconds: durationSeconds || null,
      session_start: sessionStart || null,
      source_file_path: sourceFilePath || null,
      source_csv: sourceCsv || null,
    })
    .select()
    .single();
  return data!;
}

export async function uploadSessionCSV(file: File, carProfileId: string): Promise<string> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('User not authenticated');
  }

  const safeName = sanitizeFileName(file.name || 'session.csv');
  const path = `${user.id}/${carProfileId}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;

  const { error } = await supabase.storage
    .from(SESSION_CSV_BUCKET)
    .upload(path, file, {
      contentType: 'text/csv',
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to upload CSV file: ${error.message}`);
  }

  return path;
}

export async function removeSessionCSV(filePath: string): Promise<void> {
  const { error } = await supabase.storage
    .from(SESSION_CSV_BUCKET)
    .remove([filePath]);

  if (error) {
    throw new Error(`Failed to remove CSV file: ${error.message}`);
  }
}

function triggerCsvDownload(blob: Blob, filename: string): void {
  const objectUrl = window.URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = ensureCsvExtension(filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.URL.revokeObjectURL(objectUrl);
  }
}

export async function downloadSessionCSV(
  filePath: string | null | undefined,
  filename: string,
  sourceCsv?: string | null,
  sessionId?: string,
): Promise<void> {
  if (filePath) {
    const { data, error } = await supabase.storage
      .from(SESSION_CSV_BUCKET)
      .download(filePath);

    if (!error && data) {
      triggerCsvDownload(data, filename);
      return;
    }
  }

  if (sourceCsv && sourceCsv.length > 0) {
    triggerCsvDownload(new Blob([sourceCsv], { type: 'text/csv;charset=utf-8' }), filename);
    return;
  }

  if (sessionId) {
    const { data, error } = await supabase
      .from('sessions')
      .select('source_csv')
      .eq('id', sessionId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch stored CSV: ${error.message}`);
    }

    if (data?.source_csv) {
      triggerCsvDownload(new Blob([data.source_csv], { type: 'text/csv;charset=utf-8' }), filename);
      return;
    }
  }

  throw new Error('No stored CSV available for this session');
}

export async function insertSessionRows(
  sessionId: string,
  rows: { t_seconds: number | null; t_timestamp: string | null; data: Record<string, unknown> }[],
  onProgress?: (percent: number) => void
) {
  // Batch insert in chunks of 200
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map(r => ({
      session_id: sessionId,
      t_seconds: r.t_seconds,
      t_timestamp: r.t_timestamp,
      data: r.data as unknown as never,
    }));
    await supabase.from('session_rows').insert(chunk);
    if (onProgress) {
      onProgress(Math.min(100, Math.round(((i + chunkSize) / rows.length) * 100)));
    }
  }
}

export async function insertSessionFlags(
  sessionId: string,
  flags: { severity: string; canonical_key: string; parameter_key: string; message: string; evidence: Record<string, unknown> }[]
) {
  if (flags.length === 0) return;
  const rows = flags.map(f => ({
    session_id: sessionId,
    severity: f.severity,
    canonical_key: f.canonical_key,
    parameter_key: f.parameter_key,
    message: f.message,
    evidence: f.evidence as unknown as never,
  }));
  await supabase.from('session_flags').insert(rows);
}

export async function deleteSessionFlags(sessionId: string) {
  await supabase.from('session_flags').delete().eq('session_id', sessionId);
}

export async function toggleFlagResolved(flagId: string, resolved: boolean) {
  const { error } = await supabase
    .from('session_flags')
    .update({ resolved })
    .eq('id', flagId);

  if (error) throw error;
}

// AI Settings
export async function getGeminiModel(): Promise<string> {
  const { data } = await supabase
    .from('app_settings')
    .select('setting_value')
    .eq('setting_key', 'gemini_model')
    .maybeSingle();

  return data?.setting_value || 'gemini-2.5-flash';
}

export async function saveGeminiModel(model: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('User not authenticated');

  const { error } = await supabase
    .from('app_settings')
    .upsert({
      setting_key: 'gemini_model',
      setting_value: model,
      encrypted: false,
      user_id: user.id,
    }, {
      onConflict: 'setting_key,user_id'
    });

  if (error) {
    throw new Error(`Failed to save model preference: ${error.message}`);
  }
}

// Gemini API key management
export async function getGeminiApiKey(): Promise<string | null> {
  const { data } = await supabase
    .from('app_settings')
    .select('setting_value')
    .eq('setting_key', 'gemini_api_key')
    .maybeSingle();

  return data?.setting_value || null;
}

export async function saveGeminiApiKey(apiKey: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('User not authenticated');

  const { error } = await supabase
    .from('app_settings')
    .upsert({
      setting_key: 'gemini_api_key',
      setting_value: apiKey,
      encrypted: false, // Note: In production, consider encrypting this
      user_id: user.id,
    }, {
      onConflict: 'setting_key,user_id'
    });

  if (error) {
    throw new Error(`Failed to save API key: ${error.message}`);
  }
}

export async function deleteGeminiApiKey(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('User not authenticated');

  await supabase
    .from('app_settings')
    .delete()
    .eq('setting_key', 'gemini_api_key')
    .eq('user_id', user.id);
}

export async function updateSessionWithGeminiAnalysis(
  sessionId: string,
  analysis: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('sessions')
    .update({
      gemini_analysis: analysis as unknown as never
    })
    .eq('id', sessionId);

  if (error) {
    throw new Error(`Failed to update session with Gemini analysis: ${error.message}`);
  }
}

// Car management functions
export interface CarProfile {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
  user_id?: string;
  is_admin?: boolean;
}

export async function getUserCars(): Promise<CarProfile[]> {
  const { data, error } = await supabase
    .from('car_profiles')
    .select('*')
    .neq('is_admin', true) // Filter out admin profiles
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch cars: ${error.message}`);
  }

  return data || [];
}

export async function createCarProfile(name: string, notes?: string): Promise<CarProfile> {
  const { data, error } = await supabase
    .from('car_profiles')
    .insert({ name, notes })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create car profile: ${error.message}`);
  }

  return data;
}

export async function updateCarProfile(id: string, updates: Partial<Pick<CarProfile, 'name' | 'notes'>>): Promise<void> {
  const { error } = await supabase
    .from('car_profiles')
    .update(updates)
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to update car profile: ${error.message}`);
  }
}

export async function deleteCarProfile(id: string): Promise<void> {
  const { error } = await supabase
    .from('car_profiles')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete car profile: ${error.message}`);
  }
}

export async function getCarById(id: string): Promise<CarProfile | null> {
  const { data, error } = await supabase
    .from('car_profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch car: ${error.message}`);
  }

  return data;
}

