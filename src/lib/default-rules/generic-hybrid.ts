import type { DefaultRule } from '@/lib/default-rules';

export const GENERIC_HYBRID_RULES: DefaultRule[] = [
  {
    canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C',
    normal_min: 75, normal_max: 105,
    warn_min: null, warn_max: 110,
    critical_min: null, critical_max: 115,
    min_duration_seconds: 30,
    notes: 'Attention: Coolant ran high. Hybrid cooling shares engine + inverter loops; check both. Critical: Stop driving once safe.',
  },
  {
    canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm',
    normal_min: 0, normal_max: 3800,
    warn_min: null, warn_max: 4500,
    critical_min: null, critical_max: 5500,
    min_duration_seconds: 10,
    notes: 'Hybrids typically keep ICE under 3500 RPM. Sustained high RPM often means weak hybrid battery forcing engine to do all the work.',
  },
  {
    canonical_key: 'battery_voltage_12v', parameter_key: 'battery_voltage_12v', label: '12V Auxiliary Battery', unit: 'V',
    normal_min: 12.4, normal_max: 14.8,
    warn_min: 12.2, warn_max: 15.0,
    critical_min: 11.8, critical_max: null,
    min_duration_seconds: 30,
    notes: 'Hybrid 12V auxiliary battery failure causes "no Ready light" no-start. Test if readings stay low.',
  },
  {
    canonical_key: 'intake_air_temp', parameter_key: 'intake_air_temp', label: 'Intake Air Temp', unit: '°C',
    normal_min: null, normal_max: 60,
    warn_min: null, warn_max: 70,
    critical_min: null, critical_max: 85,
    min_duration_seconds: 60,
    notes: 'High IAT reduces efficiency and increases knock risk.',
  },
  {
    canonical_key: 'engine_load', parameter_key: 'engine_load', label: 'Engine Load', unit: '%',
    normal_min: 0, normal_max: 85,
    warn_min: null, warn_max: 90,
    critical_min: null, critical_max: 95,
    min_duration_seconds: 20,
    notes: 'Sustained high engine load on a hybrid often signals depleted HV battery or aggressive driving.',
  },
];
