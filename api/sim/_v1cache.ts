// The home page of API v1 (GET /api/sim/v1/overview) is cheap and cached for a few seconds per person. An upload or a
// deletion drops that person's entry, so what they just did shows at once; everything else waits out the 10 seconds.
export const OVERVIEW_TTL_MS = 10_000;

const entries = new Map<string, { at: number; body: unknown }>();

export function cachedOverview(userId: string, now = Date.now()): unknown | undefined {
  const hit = entries.get(userId);
  return hit && now - hit.at < OVERVIEW_TTL_MS ? hit.body : undefined;
}

export function rememberOverview(userId: string, body: unknown, now = Date.now()) {
  entries.set(userId, { at: now, body });
  if (entries.size > 2000) for (const [key, value] of entries) if (now - value.at >= OVERVIEW_TTL_MS) entries.delete(key);
}

export const forgetOverview = (userId: string) => { entries.delete(userId); };
/** Tests: start from an empty cache. */
export const forgetAllOverviews = () => entries.clear();
