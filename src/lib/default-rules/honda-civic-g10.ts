import type { DefaultRule } from '@/lib/default-rules';

// Honda Civic 10th gen (2016-2021) — 1.5L turbo + 2.0L NA + 2.0L turbo (Si/Type R)
export const HONDA_CIVIC_G10_RULES: DefaultRule[] = [
  {
    canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C',
    normal_min: 80, normal_max: 105,
    warn_min: null, warn_max: 110,
    critical_min: null, critical_max: 117,
    min_duration_seconds: 30,
    notes: 'Honda 1.5T is known to dilute oil with fuel in cold climates. Sustained high coolant + short trips = check oil level often.',
  },
  {
    canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm',
    normal_min: 0, normal_max: 5000,
    warn_min: null, warn_max: 6500,
    critical_min: null, critical_max: 7000,
    min_duration_seconds: 10,
    notes: 'NA 2.0 (Sport/EX) redlines at 6800. 1.5T at 6500. Type R can sustain 7000+ briefly.',
  },
  {
    canonical_key: 'stft_b1', parameter_key: 'stft_b1', label: 'Short Term Fuel Trim B1', unit: '%',
    normal_min: -10, normal_max: 10,
    warn_min: -15, warn_max: 15,
    critical_min: -25, critical_max: 25,
    min_duration_seconds: 30,
    notes: '1.5T is sensitive to direct injection carbon buildup; trims drifting positive over time signals walnut blast time.',
  },
  {
    canonical_key: 'battery_voltage_12v', parameter_key: 'battery_voltage_12v', label: '12V Battery', unit: 'V',
    normal_min: 12.4, normal_max: 14.7,
    warn_min: 12.1, warn_max: 15.0,
    critical_min: 11.5, critical_max: null,
    min_duration_seconds: 30,
    notes: 'Honda batteries known for short lives; auto-stop disables when battery drops.',
  },
  {
    canonical_key: 'intake_air_temp', parameter_key: 'intake_air_temp', label: 'Intake Air Temp', unit: '°C',
    normal_min: null, normal_max: 55,
    warn_min: null, warn_max: 70,
    critical_min: null, critical_max: 85,
    min_duration_seconds: 60,
    notes: 'High IAT on the 1.5T can trigger limp mode; check intercooler airflow.',
  },
];
