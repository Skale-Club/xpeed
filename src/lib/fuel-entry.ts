/** Decimal keyboard entry accepts a dot or a comma, without interpreting grouping separators. */
export function parseFuelNumber(value: string): number {
  const text = value.trim();
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return NaN;
  return Number(text.replace(',', '.'));
}
