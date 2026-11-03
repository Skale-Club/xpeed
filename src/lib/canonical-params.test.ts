import { expect, it } from 'vitest';
import { matchCanonicalKey } from './canonical-params';

it.each([
  ['Long Term Fuel Trim Bank 1 (%)', 'ltft_b1'],
  ['Short Term Fuel Trim Bank 2 (%)', 'stft_b2'],
  ['LTFT B2 (%)', 'ltft_b2'],
  ['O2 Sensor B1S2 (V)', 'o2_b1s2'],
  ['Oxygen Sensor Bank 2 Sensor 1 (V)', 'o2_b2s1'],
  ['Engine Speed (rpm)', 'engine_rpm'],
  ['Vehicle Speed (km/h)', 'vehicle_speed'],
  ['HV Battery SOC (%)', 'hybrid_battery_soc'],
  ['12V Battery Voltage (V)', 'battery_voltage_12v'],
] as const)('identifies %s as %s', (header, expected) => {
  expect(matchCanonicalKey(header)?.canonical_key).toBe(expected);
});

it.each(['Injection Timing', 'Radiator Fan Speedless', 'Hybrid Battery Voltage (V)', 'Hybrid Battery Temperature (°C)'])('does not infer an unrelated diagnostic channel for %s', (header) => {
  expect(matchCanonicalKey(header)).toBeNull();
});
