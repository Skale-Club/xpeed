import type { ParsedCSV } from './csv-parser';

/** Normalize known explicit units before summaries/rules. The original CSV stays untouched. */
export function normalizeCsvUnits(parsed: ParsedCSV): ParsedCSV {
  const conversions = new Map<string, (value: number) => number>();
  for (const [header, mapping] of Object.entries(parsed.headerMapping)) {
    if (!mapping || header === parsed.timeColumn?.key) continue;
    const explicit = header.match(/(?:\(([^()]*)\)|\[([^\]]*)\])\s*$/);
    if (!explicit) continue; // older exports omit units; retain the established canonical default
    const unit = (explicit[1] ?? explicit[2]).normalize('NFKC').toLowerCase().replace(/[°\s]/g, '');
    const canonical = mapping.unit.toLowerCase().replace(/[°\s]/g, '');
    if (mapping.canonical_key === 'mpg_or_fuel_rate' && ['l/h', 'gal./h', 'gal/h'].includes(unit)) {
      // US export: MPG is left separate; only an explicit flow unit becomes L/h.
      parsed.headerMapping[header] = { ...mapping, unit: 'L/h' };
      if (unit !== 'l/h') conversions.set(header, (v) => v * 3.785411784);
      continue;
    }
    if (unit === canonical || !mapping.unit) continue;
    let convert: ((v: number) => number) | undefined;
    if (canonical === 'c') {
      if (['f', 'fahrenheit'].includes(unit)) convert = (v) => (v - 32) * 5 / 9;
      if (['k', 'kelvin'].includes(unit)) convert = (v) => v - 273.15;
      if (unit === 'celsius') convert = (v) => v;
    } else if (canonical === 'km/h') {
      if (unit === 'mph') convert = (v) => v * 1.609344;
      if (unit === 'm/s') convert = (v) => v * 3.6;
      if (['kph', 'kmh'].includes(unit)) convert = (v) => v;
    } else if (canonical === 'kpa' && unit === 'psi') convert = (v) => v * 6.894757293;
    else if (canonical === 'g/s' && unit === 'kg/hour') convert = (v) => v / 3.6;
    else if (canonical === 'v' && unit === 'mv') convert = (v) => v / 1000;
    if (convert) conversions.set(header, convert);
    else if (['c', 'km/h', 'kpa', 'v'].includes(canonical)) {
      // Refuse to label an unknown physical unit as Celsius/km/h/etc.
      throw new Error(`Unsupported unit in column "${header}". Export this sensor in ${mapping.unit}.`);
    }
  }
  if (!conversions.size) return parsed;
  return { ...parsed, rows: parsed.rows.map((row) => {
    const normalized = { ...row };
    for (const [header, convert] of conversions) {
      const value = row[header];
      if (typeof value === 'number' && Number.isFinite(value)) normalized[header] = convert(value);
    }
    return normalized;
  }) };
}
