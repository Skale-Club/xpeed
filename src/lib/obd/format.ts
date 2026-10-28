/** Display precision per unit for live OBD values. */
export function formatValue(v: number | null | undefined, unit: string): string {
  if (v == null) return '—';
  const decimals = unit === 'V' ? 2 : ['%', 'g/s', 'L/h', '°'].includes(unit) ? 1 : 0;
  return v.toFixed(decimals);
}
