import type { DefaultRule } from '@/lib/default-rules';

// Subaru WRX (VA, 2015-2021) — 2.0L FA20DIT turbo flat-4
export const SUBARU_WRX_RULES: DefaultRule[] = [
  {
    canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C',
    normal_min: 80, normal_max: 105,
    warn_min: null, warn_max: 110,
    critical_min: null, critical_max: 115,
    min_duration_seconds: 30,
    notes: 'WRX coolant should stabilize 88-95°C cruising. Track-day usage routinely sees 105-110°C; sustained 110+ requires backing off.',
  },
  {
    canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm',
    normal_min: 0, normal_max: 5500,
    warn_min: null, warn_max: 6700,
    critical_min: null, critical_max: 6800,
    min_duration_seconds: 10,
    notes: 'FA20 redlines at 6700. Pushing past requires aftermarket tune; stock engine bearings do not like sustained 6700+.',
  },
  {
    canonical_key: 'oil_temp', parameter_key: 'oil_temp', label: 'Oil Temp', unit: '°C',
    normal_min: 90, normal_max: 110,
    warn_min: null, warn_max: 120,
    critical_min: null, critical_max: 130,
    min_duration_seconds: 30,
    notes: 'WRX is known for oil temperature spikes. Aftermarket oil cooler recommended for track use. Critical = pull over.',
  },
  {
    canonical_key: 'stft_b1', parameter_key: 'stft_b1', label: 'Short Term Fuel Trim B1', unit: '%',
    normal_min: -12, normal_max: 12,
    warn_min: -18, warn_max: 18,
    critical_min: -25, critical_max: 25,
    min_duration_seconds: 30,
    notes: 'FA20DIT runs slightly richer than NA engines. Trims pegged positive often signals dying TGV motors or BPV issues.',
  },
  {
    canonical_key: 'battery_voltage_12v', parameter_key: 'battery_voltage_12v', label: '12V Battery', unit: 'V',
    normal_min: 12.3, normal_max: 14.8,
    warn_min: 12.0, warn_max: 15.2,
    critical_min: 11.5, critical_max: null,
    min_duration_seconds: 30,
    notes: 'Stock alternator is undersized for accessory-heavy setups. Weak voltage causes ECU to richen mixture.',
  },
  {
    canonical_key: 'intake_air_temp', parameter_key: 'intake_air_temp', label: 'Intake Air Temp', unit: '°C',
    normal_min: null, normal_max: 50,
    warn_min: null, warn_max: 65,
    critical_min: null, critical_max: 80,
    min_duration_seconds: 60,
    notes: 'Top-mount intercooler heat soaks in traffic. 65+°C reduces timing significantly; consider a TMIC spray or FMIC swap.',
  },
];
