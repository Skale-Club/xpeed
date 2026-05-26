import type { EngineType } from '@/lib/db';

export interface MetricHighlight {
  canonical_key: string;
  label: string;
  unit: string;
  valueType: 'avg' | 'max' | 'min';
  format?: 'integer' | 'decimal1';
  warnAbove?: number;
  criticalAbove?: number;
  warnBelow?: number;
}

export interface EngineTypeConfig {
  label: string;
  heroMetrics: MetricHighlight[];
  priorityChartIds: string[];
}

export const ENGINE_TYPE_CONFIGS: Record<EngineType, EngineTypeConfig> = {
  hybrid: {
    label: 'Hybrid',
    heroMetrics: [
      { canonical_key: 'hybrid_battery_soc', label: 'Battery SOC', unit: '%', format: 'integer', valueType: 'avg', warnBelow: 20 },
      { canonical_key: 'inverter_temp', label: 'Inverter Temp', unit: '°C', format: 'integer', valueType: 'max', warnAbove: 80, criticalAbove: 100 },
      { canonical_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C', format: 'integer', valueType: 'max', warnAbove: 100, criticalAbove: 115 },
      { canonical_key: 'mpg_or_fuel_rate', label: 'Fuel Rate', unit: 'L/h', format: 'decimal1', valueType: 'avg' },
    ],
    priorityChartIds: ['engine', 'fuel_econ', 'temperature', 'voltage', 'speed', 'fuel_trim', 'emissions'],
  },
  electric: {
    label: 'Electric',
    heroMetrics: [
      { canonical_key: 'hybrid_battery_soc', label: 'Battery Level', unit: '%', format: 'integer', valueType: 'avg', warnBelow: 15 },
      { canonical_key: 'inverter_temp', label: 'Inverter Temp', unit: '°C', format: 'integer', valueType: 'max', warnAbove: 80, criticalAbove: 100 },
      { canonical_key: 'battery_voltage_12v', label: 'Battery Voltage', unit: 'V', format: 'decimal1', valueType: 'avg' },
      { canonical_key: 'vehicle_speed', label: 'Max Speed', unit: 'km/h', format: 'integer', valueType: 'max' },
    ],
    priorityChartIds: ['voltage', 'temperature', 'speed', 'engine', 'fuel_econ', 'fuel_trim', 'emissions'],
  },
  petrol: {
    label: 'Petrol',
    heroMetrics: [
      { canonical_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C', format: 'integer', valueType: 'max', warnAbove: 100, criticalAbove: 115 },
      { canonical_key: 'engine_load', label: 'Engine Load', unit: '%', format: 'integer', valueType: 'avg', warnAbove: 80, criticalAbove: 95 },
      { canonical_key: 'stft_b1', label: 'Fuel Trim B1', unit: '%', format: 'decimal1', valueType: 'avg', warnAbove: 10, criticalAbove: 25 },
      { canonical_key: 'engine_rpm', label: 'Max RPM', unit: 'rpm', format: 'integer', valueType: 'max' },
    ],
    priorityChartIds: ['engine', 'fuel_trim', 'fuel_econ', 'temperature', 'speed', 'voltage', 'emissions'],
  },
  diesel: {
    label: 'Diesel',
    heroMetrics: [
      { canonical_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C', format: 'integer', valueType: 'max', warnAbove: 100, criticalAbove: 115 },
      { canonical_key: 'engine_load', label: 'Engine Load', unit: '%', format: 'integer', valueType: 'avg', warnAbove: 80, criticalAbove: 95 },
      { canonical_key: 'mpg_or_fuel_rate', label: 'Fuel Rate', unit: 'L/h', format: 'decimal1', valueType: 'avg' },
      { canonical_key: 'engine_rpm', label: 'Max RPM', unit: 'rpm', format: 'integer', valueType: 'max' },
    ],
    priorityChartIds: ['engine', 'fuel_econ', 'temperature', 'speed', 'voltage', 'fuel_trim', 'emissions'],
  },
};

const KEY_ALIASES: Record<string, string[]> = {
  hybrid_battery_soc: ['hybrid_battery_soc', 'hv battery', 'hv soc', 'battery soc', 'batt soc'],
  inverter_temp: ['inverter_temp', 'inverter temperature', 'mg1 temp', 'mg2 temp'],
  coolant_temp: ['coolant_temp', 'coolant', 'ect', 'water temp', '0x05'],
  engine_load: ['engine_load', 'load', '0x04'],
  stft_b1: ['stft_b1', 'short term fuel trim bank 1', 'stft1'],
  engine_rpm: ['engine_rpm', 'rpm', 'engine speed', '0x0c'],
  mpg_or_fuel_rate: ['mpg_or_fuel_rate', 'fuel rate', 'instant fuel'],
  battery_voltage_12v: ['battery_voltage_12v', 'battery', 'vpwr', '0x42'],
  vehicle_speed: ['vehicle_speed', 'speed', 'vss', '0x0d'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolveMetricValue(
  summaries: { canonical_key?: string | null; parameter_key?: string | null; label?: string | null; avg?: number | null; max?: number | null; min?: number | null }[],
  canonical_key: string,
  valueType: 'avg' | 'max' | 'min',
): number | null {
  const aliases = KEY_ALIASES[canonical_key] ?? [canonical_key];
  const item = summaries.find(s =>
    aliases.some(term => {
      const nTerm = norm(term);
      return (
        (s.canonical_key && norm(s.canonical_key) === nTerm) ||
        (s.parameter_key && norm(s.parameter_key).includes(nTerm)) ||
        (s.label && norm(s.label).includes(nTerm))
      );
    }),
  );
  if (!item) return null;
  const raw = item[valueType];
  return typeof raw === 'number' ? raw : null;
}
