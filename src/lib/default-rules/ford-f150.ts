import type { DefaultRule } from '@/lib/default-rules';

// Ford F-150 13th gen (2015-2020) — covers 2.7L EcoBoost V6, 3.5L EcoBoost V6, 5.0L Coyote V8
export const FORD_F150_RULES: DefaultRule[] = [
  {
    canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C',
    normal_min: 85, normal_max: 110,
    warn_min: null, warn_max: 113,
    critical_min: null, critical_max: 120,
    min_duration_seconds: 30,
    notes: 'EcoBoost engines run hotter than the V8. Hauling/towing pushes coolant; if temps stay 110+ with no load, check the thermostat.',
  },
  {
    canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm',
    normal_min: 0, normal_max: 4500,
    warn_min: null, warn_max: 6000,
    critical_min: null, critical_max: 6500,
    min_duration_seconds: 10,
    notes: 'Coyote V8 redlines at 7000. EcoBoost V6s at 6500. Sustained high RPM under tow is normal; sustained high RPM unloaded suggests transmission issue.',
  },
  {
    canonical_key: 'oil_temp', parameter_key: 'oil_temp', label: 'Oil Temp', unit: '°C',
    normal_min: 85, normal_max: 115,
    warn_min: null, warn_max: 125,
    critical_min: null, critical_max: 135,
    min_duration_seconds: 30,
    notes: 'F-150 oil temp climbs under heavy tow loads. Critical readings can degrade oil rapidly — change earlier.',
  },
  {
    canonical_key: 'transmission_temp', parameter_key: 'transmission_temp', label: 'Transmission Temp', unit: '°C',
    normal_min: 70, normal_max: 105,
    warn_min: null, warn_max: 115,
    critical_min: null, critical_max: 125,
    min_duration_seconds: 60,
    notes: 'The 10R80 transmission is sensitive to heat. 115+ for sustained periods = stop towing and let it cool.',
  },
  {
    canonical_key: 'battery_voltage_12v', parameter_key: 'battery_voltage_12v', label: '12V Battery', unit: 'V',
    normal_min: 12.3, normal_max: 14.8,
    warn_min: 12.0, warn_max: 15.2,
    critical_min: 11.5, critical_max: null,
    min_duration_seconds: 30,
    notes: 'Critical for stop/start systems. Low voltage disables auto-stop and can throw "battery saver" warnings.',
  },
];
