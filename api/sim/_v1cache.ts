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

// The dashboard (GET /api/sim/v1/stats) is cached the same way, per person and range, for a little longer: it is a heavier read and
// its numbers move slowly. forgetOverview drops it with the overview, so an upload or a deletion shows at once.
export const STATS_TTL_MS = 20_000;
const statsEntries = new Map<string, Map<string, { at: number; body: unknown }>>();

export function cachedStats(userId: string, range: string, now = Date.now()): unknown | undefined {
  const hit = statsEntries.get(userId)?.get(range);
  return hit && now - hit.at < STATS_TTL_MS ? hit.body : undefined;
}

export function rememberStats(userId: string, range: string, body: unknown, now = Date.now()) {
  const own = statsEntries.get(userId) ?? new Map<string, { at: number; body: unknown }>();
  own.set(range, { at: now, body });
  statsEntries.set(userId, own);
  if (statsEntries.size > 2000) for (const [key, value] of statsEntries) if ([...value.values()].every((entry) => now - entry.at >= STATS_TTL_MS)) statsEntries.delete(key);
}

export const forgetOverview = (userId: string) => { entries.delete(userId); statsEntries.delete(userId); };
/** Tests: start from an empty cache. */
export const forgetAllOverviews = () => { entries.clear(); statsEntries.clear(); };
