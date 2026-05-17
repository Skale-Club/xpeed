import type { DefaultRule } from '@/lib/default-rules';

// Tesla Model 3 — fully electric, so most ICE-oriented rules don't apply.
// We focus on the parameters that actually exist over OBD2 with a Tesla adapter:
// pack voltage, motor temps, regen behavior.
//
// NOTE: Tesla's OBD2 implementation is non-standard and requires a Tesla-specific
// scanner (e.g., Scan My Tesla). Parameter keys here follow that vendor's CSV
// export naming.
export const TESLA_MODEL3_RULES: DefaultRule[] = [
  {
    canonical_key: 'battery_voltage_hv', parameter_key: 'hv_battery_voltage', label: 'HV Battery Voltage', unit: 'V',
    normal_min: 320, normal_max: 405,
    warn_min: 310, warn_max: null,
    critical_min: 290, critical_max: null,
    min_duration_seconds: 30,
    notes: 'Tesla LR pack nominal ~360V. Below 310V = low SOC. Below 290V sustained = avoid pulling — protect pack from cell damage.',
  },
  {
    canonical_key: 'motor_temp_front', parameter_key: 'motor_temp_front', label: 'Front Motor Temp', unit: '°C',
    normal_min: null, normal_max: 80,
    warn_min: null, warn_max: 110,
    critical_min: null, critical_max: 140,
    min_duration_seconds: 30,
    notes: 'Front motor temp climbs under repeated hard launches. 140+ = power-limited mode kicks in.',
  },
  {
    canonical_key: 'motor_temp_rear', parameter_key: 'motor_temp_rear', label: 'Rear Motor Temp', unit: '°C',
    normal_min: null, normal_max: 90,
    warn_min: null, warn_max: 120,
    critical_min: null, critical_max: 150,
    min_duration_seconds: 30,
    notes: 'Rear motor does most of the work in normal driving; higher base temps expected. 150+ throttles power significantly.',
  },
  {
    canonical_key: 'battery_pack_temp', parameter_key: 'battery_pack_temp', label: 'HV Pack Temp', unit: '°C',
    normal_min: 10, normal_max: 35,
    warn_min: null, warn_max: 50,
    critical_min: null, critical_max: 65,
    min_duration_seconds: 60,
    notes: 'Optimal pack temp for charging: 25-35°C. Hot pack (>50°C) limits Supercharger speed; cold pack (<10°C) limits regen.',
  },
];
