import { openBackend } from './_backend';

export default async function vehicleVisuals(request: Request): Promise<Response> {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const json = (body: unknown, status: number, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
  if (!/^\/api\/vehicle-visuals\/?$/.test(new URL(request.url).pathname)) return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' });
  try {
    const backend = openBackend();
    if (!backend) return json({ error: 'unavailable' }, 503);
    const result = await backend.service.from('vehicle_visuals').select('*').order('key');
    if (result.error) return json({ error: 'unavailable' }, 503);
    const visuals = (result.data ?? []).map((row) => ({ key: row.key, make: row.make, model: row.model, modelAliases: row.model_aliases, yearFrom: row.year_from, yearTo: row.year_to, modelPath: row.model_path, posterPath: row.poster_path, modelSha256: row.model_sha256, credit: { author: row.author, sourceUrl: row.source_url, license: row.license, licenseUrl: row.license_url, changes: row.changes } }));
    return json({ visuals }, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch { return json({ error: 'unavailable' }, 503); }
}
