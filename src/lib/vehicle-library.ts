import { supabase } from '@/integrations/supabase/client';

const NHTSA_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isStale(cachedAt: string): boolean {
  return Date.now() - new Date(cachedAt).getTime() > CACHE_MAX_AGE_MS;
}

export async function getMakesForYear(year: number, country: string): Promise<string[]> {
  const { data: cached } = await supabase
    .from('vehicle_makes_cache')
    .select('make_name, cached_at')
    .eq('country', country)
    .eq('year', year)
    .order('make_name');

  if (cached && cached.length > 0 && !isStale(cached[0].cached_at)) {
    return cached.map((r: { make_name: string }) => r.make_name);
  }

  if (country !== 'US') return [];

  const res = await fetch(
    `${NHTSA_BASE}/GetMakesForVehicleType/car?format=json&modelyear=${year}`
  );
  if (!res.ok) throw new Error('NHTSA request failed');

  const json = await res.json() as { Results: { MakeId: number; MakeName: string }[] };
  const makes = (json.Results || []).filter((m) => m.MakeName?.trim());

  if (makes.length > 0) {
    await supabase.from('vehicle_makes_cache').upsert(
      makes.map((m) => ({
        country,
        year,
        make_id: m.MakeId,
        make_name: m.MakeName.trim(),
        cached_at: new Date().toISOString(),
      })),
      { onConflict: 'country,year,make_id' }
    );
  }

  return makes.map((m) => m.MakeName.trim()).sort((a, b) => a.localeCompare(b));
}

export async function getModelsForMakeYear(
  make: string,
  year: number,
  country: string
): Promise<string[]> {
  const { data: cached } = await supabase
    .from('vehicle_models_cache')
    .select('model_name, cached_at')
    .eq('country', country)
    .eq('year', year)
    .eq('make_name', make)
    .order('model_name');

  if (cached && cached.length > 0 && !isStale(cached[0].cached_at)) {
    return cached.map((r: { model_name: string }) => r.model_name);
  }

  if (country !== 'US') return [];

  const res = await fetch(
    `${NHTSA_BASE}/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}/vehicleType/car?format=json`
  );
  if (!res.ok) throw new Error('NHTSA request failed');

  const json = await res.json() as {
    Results: { Make_ID: number; Model_ID: number; Model_Name: string }[];
  };
  const models = (json.Results || []).filter((m) => m.Model_Name?.trim());

  if (models.length > 0) {
    await supabase.from('vehicle_models_cache').upsert(
      models.map((m) => ({
        country,
        year,
        make_name: make,
        model_id: m.Model_ID,
        model_name: m.Model_Name.trim(),
        cached_at: new Date().toISOString(),
      })),
      { onConflict: 'country,year,make_name,model_id' }
    );
  }

  return models.map((m) => m.Model_Name.trim()).sort((a, b) => a.localeCompare(b));
}
