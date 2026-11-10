/** The address of the compare screen with two kept laps loaded: the lap, and optionally the lap to measure it against. */
export const compareUrl = (lap: string, reference?: string) =>
  `/sim/compare?a=${encodeURIComponent(lap)}${reference ? `&b=${encodeURIComponent(reference)}` : ''}`;
