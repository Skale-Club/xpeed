export const config = { runtime: 'edge' };
export default async function handler(req: Request): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const region = new URL(req.url).searchParams.get('region') ?? 'NUS';
  if (req.method !== 'GET' || !['NUS', 'R10', 'R20', 'R30', 'R40', 'R50'].includes(region)) return new Response(JSON.stringify({ error: 'invalid_region' }), { status: 400, headers });
  try {
    const url = new URL('https://api.eia.gov/v2/petroleum/pri/gnd/data/');
    for (const [key, value] of Object.entries({ api_key: process.env.EIA_API_KEY || 'DEMO_KEY', frequency: 'weekly', 'data[0]': 'value', 'facets[product][]': 'EPMR', 'facets[duoarea][]': region, 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: '1' })) url.searchParams.set(key, value);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Price provider unavailable');
    const item = (await response.json()).response?.data?.[0];
    const price = Number(item?.value);
    if (!item || !Number.isFinite(price) || price <= 0 || item.units !== '$/GAL' || !/^\d{4}-\d{2}-\d{2}$/.test(item.period)) throw new Error('Invalid price');
    return new Response(JSON.stringify({ price, currency: 'USD', unit: 'US gal', region: item['area-name'], date: item.period, sourceUrl: 'https://www.eia.gov/petroleum/gasdiesel/' }), { headers: { ...headers, 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=3600' } });
  } catch { return new Response(JSON.stringify({ error: 'price_unavailable' }), { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } }); }
}
