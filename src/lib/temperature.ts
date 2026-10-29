export type TemperatureUnit = 'C' | 'F';
/** Display-only conversion. Stored readings and diagnostic limits keep their source units. */
export function temperatureValue(value: number, source: string, target: TemperatureUnit = 'C'): number {
  if (source === '°C' && target === 'F') return value * 9 / 5 + 32;
  if (source === '°F' && target === 'C') return (value - 32) * 5 / 9;
  return value;
}
export function temperatureLabel(source: string, target: TemperatureUnit = 'C'): string {
  return source === '°C' || source === '°F' ? `°${target}` : source;
}
