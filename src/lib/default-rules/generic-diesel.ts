import type { DefaultRule } from '@/lib/default-rules';

export const GENERIC_DIESEL_RULES: DefaultRule[] = [
  {
    canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C',
    normal_min: 80, normal_max: 100,
    warn_min: null, warn_max: 108,
    critical_min: null, critical_max: 115,
    min_duration_seconds: 30,
    notes: 'Diesel coolant runs slightly cooler than petrol. Sustained high temps damage the head gasket fast.',
  },
  {
    canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm',
    normal_min: 0, normal_max: 3000,
    warn_min: null, warn_max: 4000,
    critical_min: null, critical_max: 4500,
    min_duration_seconds: 10,
    notes: 'Diesels redline lower than petrol. Sustained 4000+ RPM is unusual and stressful.',
  },
  {
    canonical_key: 'battery_voltage_12v', parameter_key: 'battery_voltage_12v', label: '12V Battery', unit: 'V',
    normal_min: 12.2, normal_max: 14.8,
    warn_min: 12.0, warn_max: 15.2,
    critical_min: 11.5, critical_max: null,
    min_duration_seconds: 30,
    notes: 'Diesels need strong 12V for starter cranking; weak battery = hard starts.',
  },
  {
    canonical_key: 'intake_air_temp', parameter_key: 'intake_air_temp', label: 'Intake Air Temp', unit: '°C',
    normal_min: null, normal_max: 70,
    warn_min: null, warn_max: 85,
    critical_min: null, critical_max: 100,
    min_duration_seconds: 60,
    notes: 'Turbocharged diesels run hotter intake temps; sustained 85+°C may indicate intercooler issues.',
  },
  {
    canonical_key: 'engine_load', parameter_key: 'engine_load', label: 'Engine Load', unit: '%',
    normal_min: 0, normal_max: 80,
    warn_min: null, warn_max: 90,
    critical_min: null, critical_max: 95,
    min_duration_seconds: 20,
    notes: 'Sustained high load can clog DPF prematurely.',
  },
];
