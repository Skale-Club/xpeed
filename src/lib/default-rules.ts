export interface DefaultRule {
  canonical_key: string;
  parameter_key: string;
  label: string;
  unit: string;
  normal_min: number | null;
  normal_max: number | null;
  warn_min: number | null;
  warn_max: number | null;
  critical_min: number | null;
  critical_max: number | null;
  min_duration_seconds: number;
  notes: string;
  // New structured action fields (Improvement B1).
  // When omitted, FlagsPanel falls back to parsing `notes` for backward compat.
  what_happened?: string;
  why_it_matters?: string;
  what_to_do?: string;
}

export const DEFAULT_PRIUS_RULES: DefaultRule[] = [
  {
    canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C',
    normal_min: 75, normal_max: 105,
    warn_min: null, warn_max: 105,
    critical_min: null, critical_max: 115,
    min_duration_seconds: 30,
    notes: 'Attention: Coolant temperature ran high for a sustained period. If this repeats, check coolant level, radiator airflow, and consider a cooling system inspection. Critical: Coolant temperature reached a critical zone. Avoid heavy load; if this repeats, stop driving and get the cooling system checked.',
    what_happened: 'Engine coolant temperature exceeded the normal operating range and stayed there long enough to be a real signal, not noise.',
    why_it_matters: 'Sustained over-temp warps the cylinder head, blows the head gasket, and degrades coolant chemistry. Hybrids share the inverter cooling loop, so it can affect electric drive too.',
    what_to_do: 'Once safe, stop and let the engine cool. Check coolant level when cold (never open a hot radiator). If the level is fine, get the cooling system pressure-tested — likely thermostat, water pump, or radiator fan.',
  },
  {
    canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm',
    normal_min: 0, normal_max: 3500,
    warn_min: null, warn_max: 4500,
    critical_min: null, critical_max: 5200,
    min_duration_seconds: 10,
    notes: 'Prolonged high RPM under load can stress the engine. Prius normally stays below 3500 RPM in hybrid operation.'
  },
  {
    canonical_key: 'stft_b1', parameter_key: 'stft_b1', label: 'Short Term Fuel Trim B1', unit: '%',
    normal_min: -10, normal_max: 10,
    warn_min: -15, warn_max: 15,
    critical_min: -25, critical_max: 25,
    min_duration_seconds: 30,
    notes: 'Fuel trim swings can indicate vacuum leaks, MAF issues, or sensor drift if persistent.'
  },
  {
    canonical_key: 'ltft_b1', parameter_key: 'ltft_b1', label: 'Long Term Fuel Trim B1', unit: '%',
    normal_min: -8, normal_max: 8,
    warn_min: -12, warn_max: 12,
    critical_min: -18, critical_max: 18,
    min_duration_seconds: 60,
    notes: 'Long-term trim being high/low consistently may indicate mixture imbalance.'
  },
  {
    canonical_key: 'battery_voltage_12v', parameter_key: 'battery_voltage_12v', label: '12V Battery', unit: 'V',
    normal_min: 12.2, normal_max: 14.8,
    warn_min: 12.0, warn_max: 15.2,
    critical_min: 11.5, critical_max: null,
    min_duration_seconds: 30,
    notes: '12V low readings can cause weird electrical behavior. Consider testing the 12V battery.'
  },
  {
    canonical_key: 'intake_air_temp', parameter_key: 'intake_air_temp', label: 'Intake Air Temp', unit: '°C',
    normal_min: null, normal_max: 60,
    warn_min: null, warn_max: 70,
    critical_min: null, critical_max: 85,
    min_duration_seconds: 60,
    notes: 'High IAT can reduce efficiency and increase knock risk (even in hybrid operation).'
  },
  {
    canonical_key: 'engine_load', parameter_key: 'engine_load', label: 'Engine Load', unit: '%',
    normal_min: 0, normal_max: 85,
    warn_min: null, warn_max: 90,
    critical_min: null, critical_max: 95,
    min_duration_seconds: 20,
    notes: 'Sustained high engine load can elevate temps; monitor coolant and trims.'
  },
];
