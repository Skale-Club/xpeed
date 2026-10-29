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
  { canonical_key: 'stft_b1', label: 'Short Term Fuel Trim B1', unit: '%', keywords: ['stft', 'short term fuel trim', 'bank 1', '0x06'], priority: 4 },
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
  { canonical_key: 'hybrid_battery_soc', label: 'HV Battery SOC', unit: '%', keywords: ['soc', 'state of charge', 'hybrid battery', 'hybrid/ev battery pack remaining charge', '0x5b'], priority: 17 },
  { canonical_key: 'inverter_temp', label: 'Inverter Temp', unit: '°C', keywords: ['inverter', 'converter temp'], priority: 18 },
  { canonical_key: 'mpg_or_fuel_rate', label: 'Fuel Rate', unit: '', keywords: ['fuel rate', 'l/100km', 'mpg', '0x5e'], priority: 19 },
  { canonical_key: 'fuel_level', label: 'Fuel Level', unit: '%', keywords: ['fuel level', 'fuel input', '0x2f'], priority: 20 },
];

export function matchCanonicalKey(header: string): { canonical_key: string; label: string; unit: string } | null {
  const lower = header.toLowerCase().trim();
  // These quantities are not oxygen-sensor voltage or MAF mass flow.
  if (/oxygen.*(?:equivalence|current)/.test(lower) || /power.*maf/.test(lower)) return null;
  // Prefer the most specific sensor name: "intake manifold absolute" must
  // win over "intake", and "catalyst" over a generic "bank 1" keyword.
  let best: CanonicalMapping | null = null;
  let length = 0;
  for (const param of CANONICAL_PARAMS) {
    for (const kw of param.keywords) {
      if (lower.includes(kw.toLowerCase()) && kw.length > length) {
        best = param;
        length = kw.length;
      }
    }
  }
  if (best) return { canonical_key: best.canonical_key, label: best.label, unit: best.unit };
  return null;
}

export const PRIUS_PRIORITY_KEYS = [
  'coolant_temp', 'engine_rpm', 'vehicle_speed', 'stft_b1', 'ltft_b1',
  'battery_voltage_12v', 'intake_air_temp', 'engine_load'
];
