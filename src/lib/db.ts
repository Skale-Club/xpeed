import { supabase } from '@/integrations/supabase/client';

const SESSION_CSV_BUCKET = 'session-csv';
const SESSION_LIST_SELECT =
  'id, car_profile_id, uploaded_at, source_filename, source_file_path, session_start, session_end, duration_seconds, row_count, columns, summary, created_at, user_id, gemini_analysis, active_dtcs';
// The trip page also needs the fault codes and versions. Never `*`: sessions.source_csv holds
// the whole CSV (megabytes) and the stored report is large; both are fetched only when needed.
const SESSION_DETAIL_SELECT = `${SESSION_LIST_SELECT}, ruleset_id, ruleset_matched_via, report_version, processing_version`;
/** session_rows are read in pages: the API caps a response (1000 rows) and a trip stores 2000+. */
const ROW_PAGE_SIZE = 1000;
const ROW_PAGE_LIMIT = 100;

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
  // Cursor paging keeps inserts at the top from shifting an offset and silently
  // dropping/duplicating older trips. Preserve the callers' complete-list contract.
  const sessions: NonNullable<Awaited<ReturnType<typeof sessionPage>>['data']> = [];
  let cursor: { uploaded_at: string; id: string } | undefined;
  for (;;) {
    const { data, error } = await sessionPage(carProfileId, cursor);
    if (error) throw new Error(`Failed to load trips: ${error.message}`);
    const page = data ?? [];
    sessions.push(...page);
    if (page.length < ROW_PAGE_SIZE) break;
    const last = page[page.length - 1];
    if (cursor?.id === last.id) throw new Error('Trip pagination did not advance');
    cursor = { uploaded_at: last.uploaded_at, id: last.id };
  }
  return sessions.sort((a, b) =>
    new Date(b.session_start ?? b.uploaded_at).getTime() - new Date(a.session_start ?? a.uploaded_at).getTime()
    || b.id.localeCompare(a.id));
}

function sessionPage(carProfileId?: string, cursor?: { uploaded_at: string; id: string }) {
  let query = supabase.from('sessions').select(SESSION_LIST_SELECT)
    .order('uploaded_at', { ascending: false }).order('id', { ascending: false }).limit(ROW_PAGE_SIZE);
  if (carProfileId) query = query.eq('car_profile_id', carProfileId);
  if (cursor) {
    query = query.or(`uploaded_at.lt.${cursor.uploaded_at},and(uploaded_at.eq.${cursor.uploaded_at},id.lt.${cursor.id})`);
  }
  return query;
}

/** The trip of this car that started at this exact second, if it was already uploaded. */
export async function findSessionStartedAt(carProfileId: string, startedAt: Date): Promise<string | null> {
  const second = new Date(Math.floor(startedAt.getTime() / 1000) * 1000).toISOString();
  const { data, error } = await supabase
    .from('sessions')
    .select('id')
    .eq('car_profile_id', carProfileId)
    .eq('session_start', second)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up trip: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

export async function getSession(id: string) {
  const { data, error } = await supabase
    .from('sessions')
    .select(SESSION_DETAIL_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load trip: ${error.message}`);
  if (!data) return data;

  // Trips saved before the CSV went to storage keep it in the row. Only those need it fetched
  // (the page enables "Download CSV" from it); newer trips have source_file_path instead.
  const trip = data as unknown as Record<string, unknown>;
  if (!trip.source_file_path) {
    const { data: csv, error: csvError } = await supabase.from('sessions').select('source_csv').eq('id', id).maybeSingle();
    if (csvError) throw new Error(`Failed to load stored CSV: ${csvError.message}`);
    return { ...trip, source_csv: csv?.source_csv ?? null } as unknown as typeof data;
  }
  return data;
}

export async function getSessionFlags(sessionId: string) {
  const { data, error } = await supabase
    .from('session_flags')
    .select('*')
    .eq('session_id', sessionId)
    .order('severity');
  if (error) throw new Error(`Failed to load trip flags: ${error.message}`);
  return data || [];
}

export async function getFlagsForSessions(sessionIds: string[]) {
  const flags: NonNullable<Awaited<ReturnType<typeof flagsPage>>['data']> = [];
  // Bound URL size independently from the database's response-row cap.
  const uniqueIds = [...new Set(sessionIds)];
  for (let start = 0; start < uniqueIds.length; start += 100) {
    const ids = uniqueIds.slice(start, start + 100);
    for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
      const { data, error } = await flagsPage(ids, offset);
      if (error) throw new Error(`Failed to fetch flags: ${error.message}`);
      flags.push(...(data ?? []));
      if ((data?.length ?? 0) < ROW_PAGE_SIZE) break;
    }
  }
  return flags.sort((a, b) => a.severity.localeCompare(b.severity));
}

function flagsPage(ids: string[], offset: number) {
  return supabase.from('session_flags').select('*, sessions(source_filename, uploaded_at)')
    .in('session_id', ids).order('id').range(offset, offset + ROW_PAGE_SIZE - 1);
}

export async function getSessionRows(sessionId: string) {
  const rows: Awaited<ReturnType<typeof fetchRowsPage>> = [];
  for (let page = 0; page < ROW_PAGE_LIMIT; page++) {
    const chunk = await fetchRowsPage(sessionId, page * ROW_PAGE_SIZE);
    rows.push(...chunk);
    if (chunk.length < ROW_PAGE_SIZE) break;
  }
  return rows;
}

async function fetchRowsPage(sessionId: string, from: number) {
  const { data, error } = await supabase
    .from('session_rows')
    .select('*')
    .eq('session_id', sessionId)
    .order('t_timestamp', { ascending: true })
    .order('t_seconds', { ascending: true })
    .order('id', { ascending: true }) // stable order across pages when times repeat
    .range(from, from + ROW_PAGE_SIZE - 1);
  if (error) throw new Error(`Failed to load trip data: ${error.message}`);
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
  activeDtcs?: string[],
) {
  const { data, error } = await supabase
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
      active_dtcs: (activeDtcs ?? []) as unknown as never,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to save the trip: ${error?.message ?? 'no data returned'}`);
  }
  return data as unknown as { id: string };
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
    const { error } = await supabase.from('session_rows').insert(chunk);
    if (error) throw new Error(`Failed to save trip data: ${error.message}`);
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
  const { error } = await supabase.from('session_flags').insert(rows);
  if (error) throw new Error(`Failed to save trip flags: ${error.message}`);
}

export async function deleteSessionFlags(sessionId: string) {
  const { error } = await supabase.from('session_flags').delete().eq('session_id', sessionId);
  if (error) throw new Error(`Failed to clear trip flags: ${error.message}`);
}

type FlagInput = Parameters<typeof insertSessionFlags>[1];

/**
 * Swap a trip's flags for a freshly computed set without a window in which it has none:
 * the new flags go in first, then the previous ones are removed. If inserting fails the
 * old flags are untouched; if the cleanup fails the new ones are rolled back.
 */
export async function replaceSessionFlags(sessionId: string, flags: FlagInput) {
  const { data: previous, error: readError } = await supabase
    .from('session_flags')
    .select('id')
    .eq('session_id', sessionId);
  if (readError) throw new Error(`Failed to read trip flags: ${readError.message}`);
  const oldIds = (previous || []).map((f) => f.id);

  let newIds: string[] = [];
  if (flags.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from('session_flags')
      .insert(flags.map((f) => ({
        session_id: sessionId,
        severity: f.severity,
        canonical_key: f.canonical_key,
        parameter_key: f.parameter_key,
        message: f.message,
        evidence: f.evidence as unknown as never,
      })))
      .select('id');
    if (insertError) throw new Error(`Failed to save trip flags: ${insertError.message}`);
    newIds = (inserted || []).map((f) => f.id);
  }

  if (oldIds.length > 0) {
    const { error: deleteError } = await supabase.from('session_flags').delete().in('id', oldIds);
    if (deleteError) {
      if (newIds.length > 0) await supabase.from('session_flags').delete().in('id', newIds);
      throw new Error(`Failed to replace trip flags: ${deleteError.message}`);
    }
  }
}

export async function toggleFlagResolved(flagId: string, resolved: boolean) {
  const { error } = await supabase
    .from('session_flags')
    .update({ resolved })
    .eq('id', flagId);

  if (error) throw error;
}

// AI Settings — the model is admin-configured server-side
// (app_settings.admin_openrouter_model) and resolved by the Edge Functions.
// No per-user client model preference.

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

export async function updateSessionVersioning(
  sessionId: string,
  fields: {
    ruleset_id: string;
    ruleset_matched_via: string;
    report_version: number;
    processing_version: string;
  }
): Promise<void> {
  const { error } = await supabase
    .from('sessions')
    .update(fields as unknown as never)
    .eq('id', sessionId);

  if (error) {
    throw new Error(`Failed to update session versioning: ${error.message}`);
  }
}

export async function storeSessionReport(
  sessionId: string,
  report: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('sessions')
    .update({ report: report as unknown as never } as never)
    .eq('id', sessionId);

  if (error) {
    throw new Error(`Failed to store session report: ${error.message}`);
  }
}

// Car management functions
// 'flex' = Brazilian flex-fuel (gasoline/ethanol); analysed like petrol.
export type EngineType = 'flex' | 'petrol' | 'diesel' | 'hybrid' | 'electric';

export interface CarProfile {
  id: string;
  name: string;
  notes: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  trim: string | null;
  vin: string | null;
  engine_type: EngineType | null;
  ruleset_id: string | null;
  country: string | null;
  /** How the car is drawn: body shape and paint (see lib/car-look), or the owner's photo. */
  body_type?: string | null;
  color?: string | null;
  photo_path?: string | null;
  created_at: string;
  user_id?: string;
  is_admin?: boolean;
}

// Write-only shape used by create/update functions — keeps id/created_at/user_id
// from leaking into mutation payloads.
export interface CarProfileInput {
  name?: string;
  notes?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  trim?: string | null;
  vin?: string | null;
  engine_type?: EngineType | null;
  ruleset_id?: string | null;
  country?: string | null;
  body_type?: string | null;
  color?: string | null;
  photo_path?: string | null;
}

export async function getUserCars(): Promise<CarProfile[]> {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('User not authenticated');
  const { data, error } = await supabase
    .from('car_profiles')
    .select('*')
    .eq('user_id', user.id)
    .neq('is_admin', true) // Filter out admin profiles
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch cars: ${error.message}`);
  }

  return (data || []) as unknown as CarProfile[];
}

export async function createCarProfile(
  nameOrInput: string | CarProfileInput,
  notes?: string,
): Promise<CarProfile> {
  // Legacy positional call: createCarProfile('My Car', 'notes')
  let input: CarProfileInput;
  if (typeof nameOrInput === 'string') {
    input = { name: nameOrInput, notes };
  } else {
    input = nameOrInput;
  }

  // Auto-generate display name when omitted but year+make+model are present.
  if (!input.name?.trim() && input.year && input.make && input.model) {
    input = { ...input, name: `${input.year} ${input.make} ${input.model}`.trim() };
  }

  if (!input.name?.trim()) {
    throw new Error('Vehicle name is required (or provide year + make + model)');
  }

  const { data, error } = await supabase
    .from('car_profiles')
    .insert({
      name: input.name,
      notes: input.notes ?? null,
      make: input.make ?? null,
      model: input.model ?? null,
      year: input.year ?? null,
      trim: input.trim ?? null,
      vin: input.vin ?? null,
      // car_profiles.country is NOT NULL DEFAULT 'US': leave it out when unset so the default applies.
      ...(input.country ? { country: input.country } : {}),
      engine_type: input.engine_type ?? null,
      body_type: input.body_type ?? null,
      color: input.color ?? null,
    } as never)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create car profile: ${error.message}`);
  }

  return data as unknown as CarProfile;
}

export async function updateCarProfile(
  id: string,
  updates: Partial<CarProfileInput>,
): Promise<void> {
  // country can't be cleared (NOT NULL): an unset value means "leave it as it is".
  const { country, ...rest } = updates;
  const payload = country ? { ...rest, country } : rest;
  const { error } = await supabase
    .from('car_profiles')
    .update(payload)
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

  return data as unknown as CarProfile | null;
}

