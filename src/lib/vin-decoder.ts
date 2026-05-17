// VIN decoder using NHTSA's free vPIC API. No API key required.
// https://vpic.nhtsa.dot.gov/api/

export interface DecodedVin {
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engineType: 'petrol' | 'diesel' | 'hybrid' | 'electric' | null;
  bodyClass: string | null;
  manufacturer: string | null;
}

interface NhtsaResult {
  Variable: string;
  Value: string | null;
}

interface NhtsaResponse {
  Results?: NhtsaResult[];
}

function findValue(results: NhtsaResult[], variable: string): string | null {
  const item = results.find(r => r.Variable === variable);
  if (!item || !item.Value || item.Value === 'Not Applicable') return null;
  return item.Value;
}

function inferEngineType(results: NhtsaResult[]): DecodedVin['engineType'] {
  const fuel1 = findValue(results, 'Fuel Type - Primary')?.toLowerCase() || '';
  const electrification = findValue(results, 'Electrification Level')?.toLowerCase() || '';

  if (electrification.includes('bev') || electrification.includes('battery electric')) return 'electric';
  if (electrification.includes('hev') || electrification.includes('phev') || electrification.includes('hybrid')) return 'hybrid';
  if (fuel1.includes('diesel')) return 'diesel';
  if (fuel1.includes('gasoline') || fuel1.includes('petrol') || fuel1.includes('ethanol') || fuel1.includes('flexible')) return 'petrol';
  return null;
}

/**
 * Decode a 17-character VIN via NHTSA's public vPIC API.
 * Returns null on network failure or invalid VIN. Never throws.
 */
export async function decodeVin(vin: string): Promise<DecodedVin | null> {
  const cleaned = vin.trim().toUpperCase();
  if (cleaned.length !== 17 || !/^[A-HJ-NPR-Z0-9]{17}$/.test(cleaned)) {
    return null;
  }

  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${cleaned}?format=json`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const data: NhtsaResponse = await res.json();
    const results = data.Results || [];

    const yearStr = findValue(results, 'Model Year');
    const yearNum = yearStr ? parseInt(yearStr, 10) : null;

    return {
      vin: cleaned,
      year: yearNum && yearNum >= 1900 && yearNum <= 2100 ? yearNum : null,
      make: findValue(results, 'Make'),
      model: findValue(results, 'Model'),
      trim: findValue(results, 'Trim'),
      engineType: inferEngineType(results),
      bodyClass: findValue(results, 'Body Class'),
      manufacturer: findValue(results, 'Manufacturer Name'),
    };
  } catch {
    // Network error, CORS, timeout — fail gracefully.
    return null;
  }
}
