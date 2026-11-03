// Canonical parameter mapping for Prius 2010

export interface CanonicalMapping {
  canonical_key: string;
  label: string;
  unit: string;
  keywords: string[];
  priority: number; // lower = more important for Prius
}

export const CANONICAL_PARAMS: CanonicalMapping[] = [
  { canonical_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C', keywords: ['coolant', 'engine coolant', 'ect', '0x05'], priority: 1 },
  { canonical_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm', keywords: ['rpm', 'engine speed', '0x0c'], priority: 2 },
  { canonical_key: 'vehicle_speed', label: 'Vehicle Speed', unit: 'km/h', keywords: ['speed', 'vehicle speed', 'km/h', 'mph', '0x0d'], priority: 3 },
  { canonical_key: 'stft_b1', label: 'Short Term Fuel Trim B1', unit: '%', keywords: ['stft', 'short term fuel trim', '0x06'], priority: 4 },
  { canonical_key: 'ltft_b1', label: 'Long Term Fuel Trim B1', unit: '%', keywords: ['ltft', 'long term fuel trim', '0x07'], priority: 5 },
  { canonical_key: 'battery_voltage_12v', label: '12V Battery', unit: 'V', keywords: ['control module voltage', 'battery voltage', '12v', '0x42', 'control module', 'vpwr'], priority: 6 },
  { canonical_key: 'intake_air_temp', label: 'Intake Air Temp', unit: '°C', keywords: ['intake', 'iat', '0x0f'], priority: 7 },
  { canonical_key: 'engine_load', label: 'Engine Load', unit: '%', keywords: ['load', 'engine_load', '0x04'], priority: 8 },
  { canonical_key: 'throttle_position', label: 'Throttle Position', unit: '%', keywords: ['throttle', '0x11'], priority: 9 },
  { canonical_key: 'maf', label: 'MAF', unit: 'g/s', keywords: ['maf', 'mass air flow', '0x10'], priority: 10 },
  { canonical_key: 'map', label: 'MAP', unit: 'kPa', keywords: ['map', 'manifold absolute', '0x0b'], priority: 11 },
  { canonical_key: 'o2_b1s1', label: 'O2 Sensor B1S1', unit: 'V', keywords: ['o2', 'oxygen sensor', 'b1s1', '0x14'], priority: 12 },
  { canonical_key: 'o2_b1s2', label: 'O2 Sensor B1S2', unit: 'V', keywords: ['b1s2', '0x15'], priority: 13 },
  { canonical_key: 'catalyst_temp', label: 'Catalyst Temp', unit: '°C', keywords: ['catalyst', 'cat temp', '0x3c'], priority: 14 },
  { canonical_key: 'ambient_air_temp', label: 'Ambient Temp', unit: '°C', keywords: ['ambient', '0x46'], priority: 15 },
  { canonical_key: 'fuel_system_status', label: 'Fuel System', unit: '', keywords: ['fuel system', '0x03'], priority: 16 },
  { canonical_key: 'hybrid_battery_soc', label: 'HV Battery SOC', unit: '%', keywords: ['soc', 'state of charge', 'hybrid battery soc', 'hybrid battery remaining life', 'hybrid/ev battery pack remaining charge', '0x5b'], priority: 17 },
  { canonical_key: 'inverter_temp', label: 'Inverter Temp', unit: '°C', keywords: ['inverter', 'converter temp'], priority: 18 },
  { canonical_key: 'mpg_or_fuel_rate', label: 'Fuel Rate', unit: '', keywords: ['fuel rate', 'l/100km', 'mpg', '0x5e'], priority: 19 },
  { canonical_key: 'fuel_level', label: 'Fuel Level', unit: '%', keywords: ['fuel level', 'fuel input', '0x2f'], priority: 20 },
];

export function matchCanonicalKey(header: string): { canonical_key: string; label: string; unit: string } | null {
  const lower = header.toLowerCase().trim();
  // Fuel efficiency, consumption per distance and flow are different dimensions.
  if (/mpg/i.test(lower) && /imperial|imp\b|uk\b/.test(lower)) return { canonical_key: 'fuel_economy_mpg_imperial', label: 'Fuel economy', unit: 'MPG (UK)' };
  if (/mpg/i.test(lower)) return { canonical_key: 'fuel_economy_mpg', label: 'Fuel economy', unit: 'MPG' };
  if (/l\/100\s*km/i.test(lower)) return { canonical_key: 'fuel_consumption_per_distance', label: 'Fuel consumption', unit: 'L/100km' };
  if (/km\/l/i.test(lower)) return { canonical_key: 'fuel_economy_kml', label: 'Fuel economy', unit: 'km/L' };
  // These quantities are not oxygen-sensor voltage or MAF mass flow.
  if (/oxygen.*(?:equivalence|current)/.test(lower) || /power.*maf/.test(lower)) return null;
  const normalized = lower.replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  const bank = /\b(?:bank\s*|b)([12])\b/.exec(normalized)?.[1] ?? '1';
  const trim = /\b(short|long)\s+term\s+fuel\s+trim\b/.exec(normalized)?.[1]
    ?? (/\bstft\b/.test(normalized) ? 'short' : /\bltft\b/.test(normalized) ? 'long' : null);
  if (trim) return { canonical_key: `${trim === 'short' ? 'stft' : 'ltft'}_b${bank}`, label: `${trim === 'short' ? 'Short' : 'Long'} Term Fuel Trim B${bank}`, unit: '%' };

  const sensor = /\b(?:bank\s*|b)([12])\s*(?:sensor\s*|s)([12])\b/.exec(normalized);
  if (sensor) return { canonical_key: `o2_b${sensor[1]}s${sensor[2]}`, label: `O2 Sensor B${sensor[1]}S${sensor[2]}`, unit: 'V' };
  // An unspecified traction-battery reading must not become a 12V voltage or SOC reading.
  if (/\b(?:hv|hybrid|traction|high voltage)\s+battery\b/.test(normalized) && !/\b(?:soc|state of charge|remaining life)\b/.test(normalized)) return null;

  let best: CanonicalMapping | null = null;
  let bestScore = 0;
  for (const param of CANONICAL_PARAMS) {
    if (lower === param.canonical_key) return { canonical_key: param.canonical_key, label: param.label, unit: param.unit };
    for (const kw of param.keywords) {
      const keyword = kw.toLowerCase().replace(/[_-]/g, ' ');
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(normalized) && keyword.length > bestScore) {
        best = param;
        bestScore = keyword.length;
      }
    }
  }
  return best ? { canonical_key: best.canonical_key, label: best.label, unit: best.unit } : null;
}

export const PRIUS_PRIORITY_KEYS = [
  'coolant_temp', 'engine_rpm', 'vehicle_speed', 'stft_b1', 'ltft_b1',
  'battery_voltage_12v', 'intake_air_temp', 'engine_load'
];
