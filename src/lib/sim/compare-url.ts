/**
 * The address of the compare screen with laps loaded, named by the ids the server gave them: the lap, and optionally the lap to
 * measure it against. Without a reference the lap is measured against the person's personal best on the same track and car.
 */
export const compareUrl = (lapId: string, referenceId?: string | null) =>
  `/virtual/compare?a=${encodeURIComponent(lapId)}${referenceId ? `&b=${encodeURIComponent(referenceId)}` : ''}`;

/** The two lap ids an address names (`?a=&b=`); either may be missing. */
export function compareParams(params: URLSearchParams): { a: string | null; b: string | null } {
  return { a: params.get('a') || null, b: params.get('b') || null };
}
