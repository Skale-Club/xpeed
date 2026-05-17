---
phase: 04-performance-optimization
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/db.ts
  - src/pages/Index.tsx
  - src/pages/HistoryPage.tsx
  - supabase/migrations/20260517_dashboard_stats_rpc.sql
autonomous: true
requirements:
  - PERF-01   # Eliminate N+1 query patterns
  - PERF-02   # Dashboard sub-1s load time
  - PERF-03   # Pagination + row-count transparency
  - PERF-04   # DB-side aggregation via RPC
  - PERF-05   # Memoization and re-render prevention
  - PERF-06   # React Query migration for session fetching

must_haves:
  truths:
    - "Dashboard loads all visible data in a single round-trip to session_flags (1 DB call instead of N)"
    - "HistoryPage flag counts load with 1 batch query, not 1 query per session"
    - "Users see a warning toast when session rows are silently truncated at 1000"
    - "getSessionRows returns total_count so callers know when data is incomplete"
    - "Trend + health score data is pre-aggregated in PostgreSQL, not computed in JavaScript"
    - "filteredSessions, trendData, and stat derivations are memoized; no redundant re-renders on unrelated state change"
    - "Session list on dashboard uses useQuery with stale-while-revalidate, no raw useState+useEffect fetch"
  artifacts:
    - path: "supabase/migrations/20260517_dashboard_stats_rpc.sql"
      provides: "get_dashboard_stats(car_profile_id uuid, date_from timestamptz) Supabase RPC"
      contains: "CREATE OR REPLACE FUNCTION get_dashboard_stats"
    - path: "src/lib/db.ts"
      provides: "Updated getSessionRows returning {data, totalCount}, getDashboardStats RPC wrapper"
      exports: ["getSessionRows", "getDashboardStats", "getFlagsForSessions"]
    - path: "src/pages/Index.tsx"
      provides: "N+1-free dashboard, useQuery-driven fetch, memoized derivations"
      contains: "useQuery"
    - path: "src/pages/HistoryPage.tsx"
      provides: "Batch flag loading via getFlagsForSessions"
      contains: "getFlagsForSessions"
  key_links:
    - from: "src/pages/Index.tsx"
      to: "src/lib/db.ts#getDashboardStats"
      via: "useQuery hook calling getDashboardStats RPC wrapper"
      pattern: "getDashboardStats"
    - from: "src/pages/HistoryPage.tsx"
      to: "src/lib/db.ts#getFlagsForSessions"
      via: "single batch call with all session IDs"
      pattern: "getFlagsForSessions"
    - from: "src/lib/db.ts#getSessionRows"
      to: "supabase session_rows table"
      via: "Supabase .select('*, count(*)')"
      pattern: "totalCount|total_count"
---

<objective>
Eliminate every N+1 query pattern in the dashboard and history page, add pagination
transparency for session rows, push stat aggregation into PostgreSQL, and migrate session
fetching to TanStack Query.

Purpose: Dashboard currently executes up to 40+ serial DB round-trips on load (20 sessions
x 2 N+1 loops). This makes it unusable with moderate data. Every fix here directly closes a
known issue from CONCERNS.md and hits the project's < 1s load-time success metric.

Output:
- supabase/migrations/20260517_dashboard_stats_rpc.sql (new RPC function)
- src/lib/db.ts (getSessionRows with count, getDashboardStats wrapper)
- src/pages/Index.tsx (useQuery, memoized derivations, no N+1 loop)
- src/pages/HistoryPage.tsx (batch flag load, no N+1 loop)
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/codebase/CONCERNS.md
@.planning/codebase/ARCHITECTURE.md

<!-- Source files being modified — read before touching -->
@src/lib/db.ts
@src/pages/Index.tsx
@src/pages/HistoryPage.tsx
</context>

<interfaces>
<!-- Key contracts the executor needs. Do not explore these files again. -->

From src/lib/db.ts (existing, unchanged):
```typescript
// Already exists — use this, do not re-implement
export async function getFlagsForSessions(sessionIds: string[]): Promise<SessionFlag[]>
// Batch-fetches flags for multiple sessions in ONE query via .in('session_id', sessionIds)

export async function getSessions(carProfileId?: string): Promise<Session[]>
// Returns all sessions for a car profile, ordered by uploaded_at DESC

export async function getSessionFlags(sessionId: string): Promise<SessionFlag[]>
// Single-session fetch — only keep this for session detail pages (SessionDetail.tsx)
```

From src/pages/Index.tsx (existing N+1 loop to eliminate — lines 131-150):
```typescript
// BAD PATTERN — replace the entire for..of loop:
for (const session of sessionsForTrend) {
  const flags = await getSessionFlags(session.id);  // N DB calls
  ...
}

// GOOD PATTERN — one call:
const allFlags = await getFlagsForSessions(sessionsForTrend.map(s => s.id));
// Then group by session_id client-side using reduce/Map
```

From src/pages/HistoryPage.tsx (existing N+1 pattern — lines 101-109):
```typescript
// BAD PATTERN — currently:
await Promise.all(
  s.slice(0, 50).map(async (session: any) => {
    const flags = await getSessionFlags(session.id);  // 50 parallel DB calls
    ...
  })
);

// GOOD PATTERN:
const batchFlags = await getFlagsForSessions(s.slice(0, 50).map(s => s.id));
// Group into counts map client-side
```

TanStack Query v5 pattern (installed at @tanstack/react-query ^5.83.0):
```typescript
import { useQuery, useQueryClient } from '@tanstack/react-query';

// Session list query key convention:
const QUERY_KEYS = {
  sessions: (carProfileId: string) => ['sessions', carProfileId] as const,
  dashboardStats: (carProfileId: string, dateRange: string) =>
    ['dashboardStats', carProfileId, dateRange] as const,
};

const { data: sessions = [], isLoading } = useQuery({
  queryKey: QUERY_KEYS.sessions(selectedCarId!),
  queryFn: () => getSessions(selectedCarId!),
  enabled: !!selectedCarId,
  staleTime: 30_000,  // 30 seconds — don't refetch on every mount
});
```

New getDashboardStats RPC signature (to create):
```typescript
// In src/lib/db.ts — add this new export:
export interface DashboardStats {
  total_sessions: number;
  total_duration_seconds: number;
  health_score: number;          // 0-100, computed in SQL
  status: 'Excellent' | 'Good' | 'Attention' | 'Critical';
  last_upload: string | null;    // ISO timestamp
  trend_data: Array<{
    session_id: string;
    date_label: string;
    attention_count: number;
    critical_count: number;
    score: number;
  }>;
}

export async function getDashboardStats(
  carProfileId: string,
  dateFrom: Date,
  timezone: string
): Promise<DashboardStats | null>
```

Updated getSessionRows signature (src/lib/db.ts):
```typescript
export interface SessionRowsResult {
  data: SessionRow[];
  totalCount: number;    // actual row count in DB for this session
  truncated: boolean;    // true when totalCount > data.length
}

export async function getSessionRows(
  sessionId: string,
  offset?: number,
  limit?: number
): Promise<SessionRowsResult>
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: SQL migration — get_dashboard_stats RPC + getSessionRows count fix</name>
  <files>
    supabase/migrations/20260517_dashboard_stats_rpc.sql
    src/lib/db.ts
  </files>
  <action>
**Step 1 — Create the SQL migration file.**

Write `supabase/migrations/20260517_dashboard_stats_rpc.sql` with a PostgreSQL function:

```sql
CREATE OR REPLACE FUNCTION get_dashboard_stats(
  p_car_profile_id UUID,
  p_date_from TIMESTAMPTZ,
  p_timezone TEXT DEFAULT 'UTC'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  WITH session_scope AS (
    SELECT s.id, s.uploaded_at, s.session_start, s.duration_seconds
    FROM sessions s
    WHERE s.car_profile_id = p_car_profile_id
      AND COALESCE(s.session_start, s.uploaded_at) >= p_date_from
  ),
  flag_agg AS (
    SELECT
      sf.session_id,
      COUNT(*) FILTER (WHERE sf.severity = 'attention') AS attention_count,
      COUNT(*) FILTER (WHERE sf.severity = 'critical')  AS critical_count
    FROM session_flags sf
    WHERE sf.session_id IN (SELECT id FROM session_scope)
    GROUP BY sf.session_id
  ),
  session_scores AS (
    SELECT
      ss.id AS session_id,
      TO_CHAR(
        COALESCE(ss.session_start, ss.uploaded_at) AT TIME ZONE p_timezone,
        'Mon DD'
      ) AS date_label,
      COALESCE(fa.attention_count, 0) AS attention_count,
      COALESCE(fa.critical_count, 0)  AS critical_count,
      GREATEST(0,
        100
        - COALESCE(fa.critical_count, 0) * 20
        - COALESCE(fa.attention_count, 0) * 5
      ) AS score
    FROM session_scope ss
    LEFT JOIN flag_agg fa ON fa.session_id = ss.id
    ORDER BY COALESCE(ss.session_start, ss.uploaded_at) ASC
  ),
  aggregates AS (
    SELECT
      COUNT(*)                              AS total_sessions,
      COALESCE(SUM(ss2.duration_seconds),0) AS total_duration_seconds,
      MAX(ss2.uploaded_at)                  AS last_upload
    FROM sessions ss2
    WHERE ss2.car_profile_id = p_car_profile_id
      AND COALESCE(ss2.session_start, ss2.uploaded_at) >= p_date_from
  ),
  health AS (
    SELECT ROUND(AVG(score))::INT AS avg_score
    FROM session_scores
  )
  SELECT INTO v_result jsonb_build_object(
    'total_sessions',        (SELECT total_sessions FROM aggregates),
    'total_duration_seconds',(SELECT total_duration_seconds FROM aggregates),
    'last_upload',           (SELECT last_upload FROM aggregates),
    'health_score',          COALESCE((SELECT avg_score FROM health), 100),
    'status',                CASE
                               WHEN COALESCE((SELECT avg_score FROM health), 100) < 60 THEN 'Critical'
                               WHEN COALESCE((SELECT avg_score FROM health), 100) < 80 THEN 'Attention'
                               WHEN COALESCE((SELECT avg_score FROM health), 100) < 95 THEN 'Good'
                               ELSE 'Excellent'
                             END,
    'trend_data',            COALESCE(
                               (SELECT jsonb_agg(
                                  jsonb_build_object(
                                    'session_id',      session_id,
                                    'date_label',      date_label,
                                    'attention_count', attention_count,
                                    'critical_count',  critical_count,
                                    'score',           score
                                  ) ORDER BY date_label
                                ) FROM session_scores),
                               '[]'::jsonb
                             )
  );

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated users (RLS on underlying tables handles data isolation)
GRANT EXECUTE ON FUNCTION get_dashboard_stats(UUID, TIMESTAMPTZ, TEXT) TO authenticated;
```

**Step 2 — Update `src/lib/db.ts`.**

Add two new exports and update `getSessionRows`. Do NOT remove any existing exports.

2a. Add TypeScript interfaces near the top of the file (after the SESSION_LIST_SELECT constant):

```typescript
export interface SessionRowsResult {
  data: Array<Record<string, unknown> & { id: string; session_id: string; t_seconds: number | null; t_timestamp: string | null }>;
  totalCount: number;
  truncated: boolean;
}

export interface DashboardStatsRPC {
  total_sessions: number;
  total_duration_seconds: number;
  health_score: number;
  status: 'Excellent' | 'Good' | 'Attention' | 'Critical';
  last_upload: string | null;
  trend_data: Array<{
    session_id: string;
    date_label: string;
    attention_count: number;
    critical_count: number;
    score: number;
  }>;
}
```

2b. Replace `getSessionRows` (lines 71-79 of the original) with:

```typescript
export async function getSessionRows(
  sessionId: string,
  offset = 0,
  limit = 1000
): Promise<SessionRowsResult> {
  // Get count first (head request — no data transferred)
  const { count } = await supabase
    .from('session_rows')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);

  const totalCount = count ?? 0;

  const { data } = await supabase
    .from('session_rows')
    .select('*')
    .eq('session_id', sessionId)
    .order('t_seconds', { ascending: true })
    .range(offset, offset + limit - 1);

  return {
    data: (data ?? []) as SessionRowsResult['data'],
    totalCount,
    truncated: totalCount > offset + limit,
  };
}
```

2c. Add `getDashboardStats` at the end of the file, before any existing car management functions:

```typescript
export async function getDashboardStats(
  carProfileId: string,
  dateFrom: Date,
  timezone: string
): Promise<DashboardStatsRPC | null> {
  const { data, error } = await supabase.rpc('get_dashboard_stats', {
    p_car_profile_id: carProfileId,
    p_date_from: dateFrom.toISOString(),
    p_timezone: timezone,
  });

  if (error) {
    console.error('getDashboardStats RPC error:', error);
    return null;
  }

  return data as DashboardStatsRPC;
}
```

Apply the migration to the remote Supabase project:
```
npx supabase db push
```
(If `supabase` CLI is not linked, run `npx supabase link` first with the project ref.)
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>
- `supabase/migrations/20260517_dashboard_stats_rpc.sql` exists and is syntactically valid SQL
- `src/lib/db.ts` exports `getSessionRows` with `SessionRowsResult` return type
- `src/lib/db.ts` exports `getDashboardStats`
- `npx tsc --noEmit` passes with zero errors relating to these new exports
- Migration has been pushed to Supabase (or is ready to push if offline)
  </done>
</task>

<task type="auto">
  <name>Task 2: Fix Index.tsx — eliminate N+1, migrate to useQuery, memoize derivations</name>
  <files>src/pages/Index.tsx</files>
  <action>
This task rewrites the data-fetching and derivation logic in Index.tsx. The JSX/render
section is NOT changed — only the hook section at the top of the component.

**Changes to make (surgical, line-level):**

1. **Update imports** — add TanStack Query and the two new db functions:
```typescript
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSessions, getFlagsForSessions, getDashboardStats, toggleFlagResolved } from '@/lib/db';
// Remove: getSessionFlags (no longer used here)
```

2. **Replace the `allSessions` useState + `loadDashboard` useCallback + its useEffect** with a single
   `useQuery` call. Keep all other useState declarations (loading is derived from isLoading now):

```typescript
// REMOVE these three blocks:
//   const [loading, setLoading] = useState(true);
//   const [allSessions, setAllSessions] = useState<any[]>([]);
//   const loadDashboard = useCallback(async () => { ... }, [selectedCarId]);
//   useEffect(() => { loadDashboard(); }, [loadDashboard]);

// REPLACE with:
const queryClient = useQueryClient();

const { data: allSessions = [], isLoading: sessionsLoading } = useQuery({
  queryKey: ['sessions', selectedCarId],
  queryFn: () => getSessions(selectedCarId!),
  enabled: !!selectedCarId,
  staleTime: 30_000,
});
```

3. **Replace the stats `useEffect` (lines 104-175) that loops calling `getSessionFlags`** with a
   single `useQuery` that calls `getDashboardStats`:

```typescript
// Compute dateFrom from dateRange for the RPC call
const dateFrom = useMemo(() => {
  const now = new Date();
  if (dateRange === '7d')  return subDays(now, 7);
  if (dateRange === '30d') return subDays(now, 30);
  if (dateRange === '90d') return subDays(now, 90);
  return new Date(0);
}, [dateRange]);

const { data: dashboardStatsRPC, isLoading: statsLoading } = useQuery({
  queryKey: ['dashboardStats', selectedCarId, dateRange],
  queryFn: () => getDashboardStats(selectedCarId!, dateFrom, timezone),
  enabled: !!selectedCarId && allSessions.length > 0,
  staleTime: 60_000,
});
```

4. **Derive `stats` and `trendData` from the RPC result using `useMemo`** (replacing the
   `useState<DashboardStats>` + `setStats` pattern):

```typescript
const stats: DashboardStats = useMemo(() => {
  if (!dashboardStatsRPC) {
    return { totalSessions: 0, totalDurationSeconds: 0, healthScore: 100, status: 'Excellent', lastUpload: null };
  }
  return {
    totalSessions: dashboardStatsRPC.total_sessions,
    totalDurationSeconds: dashboardStatsRPC.total_duration_seconds,
    healthScore: dashboardStatsRPC.health_score,
    status: dashboardStatsRPC.status,
    lastUpload: dashboardStatsRPC.last_upload ? new Date(dashboardStatsRPC.last_upload) : null,
  };
}, [dashboardStatsRPC]);

const trendData: TrendData[] = useMemo(() => {
  if (!dashboardStatsRPC?.trend_data) return [];
  return dashboardStatsRPC.trend_data.map(t => ({
    id: t.session_id,
    date: t.date_label,
    attention: t.attention_count,
    critical: t.critical_count,
    score: t.score,
  }));
}, [dashboardStatsRPC]);
```

5. **Fix the `calculateGeneralStats` useEffect** — it already uses `getFlagsForSessions` (good),
   but it runs as a raw useEffect. Convert it to a `useQuery`:

```typescript
const { data: generalStats = { totalDistance: 0, avgFuel: 0, problemCount: 0, healthScore: 100, problems: [] } } =
  useQuery({
    queryKey: ['generalStats', selectedCarId, allSessions.map(s => s.id).join(','), distanceUnit],
    queryFn: async () => {
      // Move the entire body of calculateGeneralStats here.
      // It already calls getFlagsForSessions (1 batch call) — keep that.
      // Return the object instead of calling setGeneralStats.
      // ... (inline the existing logic verbatim, just change setGeneralStats -> return)
    },
    enabled: allSessions.length > 0,
    staleTime: 60_000,
  });
```

6. **Update `handleUploadComplete`** — instead of calling `loadDashboard()` (which no longer
   exists), invalidate the query cache:

```typescript
const handleUploadComplete = useCallback((sessionId: string) => {
  queryClient.invalidateQueries({ queryKey: ['sessions', selectedCarId] });
  queryClient.invalidateQueries({ queryKey: ['dashboardStats', selectedCarId] });
  queryClient.invalidateQueries({ queryKey: ['generalStats', selectedCarId] });
  setIsUploadOpen(false);
  navigate(`/session/${sessionId}`);
}, [navigate, queryClient, selectedCarId]);
```

7. **Remove the now-unused `generalStats` useState** and the `setGeneralStats` calls in
   `handleToggleResolved`. For the optimistic update in `handleToggleResolved`, use
   `queryClient.setQueryData` instead:

```typescript
const handleToggleResolved = async (flagId: string, currentResolved: boolean) => {
  try {
    await toggleFlagResolved(flagId, !currentResolved);
    // Optimistic: refetch generalStats query
    queryClient.invalidateQueries({ queryKey: ['generalStats', selectedCarId] });
    toast.success(currentResolved ? 'Issue marked as unresolved' : 'Issue marked as resolved');
  } catch (err) {
    console.error('Failed to toggle resolved status:', err);
    toast.error('Failed to update status');
  }
};
```

8. **Update the loading gate** at the render return:

```typescript
// Replace: if (loading || statsLoading)
if (sessionsLoading || statsLoading)
```

9. **Keep `filteredSessions` and `recentSessions` useMemo as-is** — they are already correct.

10. **Remove the `[statsLoading, setStatsLoading]` useState** — it is now derived from the query.

DO NOT change:
- The JSX render section below the hook declarations
- The `DashboardStats`, `TrendData` interface declarations
- The `formatDuration`, `getStatusColor` helper functions
- The `visibleProblems` derivation
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -40</automated>
  </verify>
  <done>
- `src/pages/Index.tsx` contains zero calls to `getSessionFlags` (the N+1 source)
- File contains `useQuery` import from `@tanstack/react-query`
- File contains `getDashboardStats` import from `@/lib/db`
- `npx tsc --noEmit` passes with no errors in Index.tsx
- Dashboard renders without runtime errors in browser (open localhost:5173, select a car, confirm no console errors)
  </done>
</task>

<task type="auto">
  <name>Task 3: Fix HistoryPage.tsx N+1 + wire getSessionRows truncation toast</name>
  <files>src/pages/HistoryPage.tsx</files>
  <action>
Two independent fixes in HistoryPage.tsx. Do not change the JSX render section or
navigation/delete/rename logic.

**Fix A — Replace the N+1 flag-counts loop (lines 99-110).**

Current bad pattern (Promise.all with individual getSessionFlags per session):
```typescript
await Promise.all(
  s.slice(0, 50).map(async (session: any) => {
    const flags = await getSessionFlags(session.id);
    counts[session.id] = { ... };
  })
);
```

Replace with:
```typescript
// ONE query for all 50 sessions
const allFlags = await getFlagsForSessions(s.slice(0, 50).map((session: any) => session.id));

// Group into counts map client-side
const counts: Record<string, { attention: number; critical: number }> = {};
for (const flag of allFlags) {
  if (!counts[flag.session_id]) counts[flag.session_id] = { attention: 0, critical: 0 };
  if (flag.severity === 'attention') counts[flag.session_id].attention++;
  if (flag.severity === 'critical')  counts[flag.session_id].critical++;
}
```

Update the import at line 20 — remove `getSessionFlags`, keep `getFlagsForSessions`:
```typescript
import { getSessions, getFlagsForSessions, getSessionRows, deleteSession, updateSession, downloadSessionCSV } from '@/lib/db';
```

**Fix B — Handle getSessionRows truncation in the detail-load effect (lines 116-141).**

`getSessionRows` now returns `SessionRowsResult` instead of a plain array. Update the
session detail loading effect:

```typescript
// Change: const [f, r] = await Promise.all([
//   getSessionFlags(session.id),
//   getSessionRows(session.id),
// ]);
// setFlags(f);
// setRows(r);

const [f, rowsResult] = await Promise.all([
  getSessionFlags(session.id),  // keep single-session call here — detail view needs full flag list
  getSessionRows(session.id),
]);
setFlags(f);
setRows(rowsResult.data);

if (rowsResult.truncated) {
  toast.warning(
    `Showing first 1,000 of ${rowsResult.totalCount.toLocaleString()} data rows. Full CSV available via Download.`,
    { duration: 6000 }
  );
}
```

Ensure `toast` is already imported from `sonner` (it is — line 26 of original).

No other changes. The JSX, pagination controls, delete dialog, and rename UI remain untouched.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -40</automated>
  </verify>
  <done>
- `src/pages/HistoryPage.tsx` contains zero calls to `getSessionFlags` in the session-list loading effect (the N+1 source)
- File imports `getFlagsForSessions` and uses it in the list-load effect
- `rowsResult.data` is passed to `setRows` (not the raw result object)
- `toast.warning` fires when `rowsResult.truncated` is true
- `npx tsc --noEmit` passes with no errors in HistoryPage.tsx
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
- SQL RPC function `get_dashboard_stats` in new migration file (ready to push)
- `getSessionRows` now returns `{ data, totalCount, truncated }` with explicit pagination
- `getDashboardStats` RPC wrapper in db.ts
- Index.tsx migrated to useQuery; N+1 loop replaced by single RPC call per date range change
- HistoryPage.tsx N+1 replaced by single `getFlagsForSessions` batch call
- Truncation toast shows when session has more than 1000 rows
  </what-built>
  <how-to-verify>
1. Run `npm run dev` and open http://localhost:5173
2. Open browser DevTools → Network tab → filter by "XHR/Fetch"
3. Select a car profile on the dashboard
4. Confirm: at most 2-3 Supabase API calls fire on dashboard load (NOT 20+)
5. Open the History page — confirm: 1 batch flags call fires (not 50 parallel ones)
6. In DevTools Console, confirm no TypeScript or runtime errors
7. Verify `supabase/migrations/20260517_dashboard_stats_rpc.sql` exists and reads correctly
8. Run `npx tsc --noEmit` — confirm zero errors
  </how-to-verify>
  <resume-signal>Type "approved" if everything looks correct, or describe which check failed</resume-signal>
</task>

</tasks>

<verification>
Run these checks after all tasks complete:

```bash
# TypeScript: zero errors across the project
npx tsc --noEmit

# No remaining getSessionFlags calls in Index.tsx (N+1 source)
grep -n "getSessionFlags" src/pages/Index.tsx
# Expected: 0 results

# No remaining getSessionFlags calls in HistoryPage session-list effect
grep -n "getSessionFlags" src/pages/HistoryPage.tsx
# Expected: exactly 1 result (the detail-view call inside the second useEffect — this is correct)

# Confirm getFlagsForSessions is used in both pages
grep -rn "getFlagsForSessions" src/pages/
# Expected: Index.tsx (via generalStats query) AND HistoryPage.tsx (batch load)

# Migration file exists
ls supabase/migrations/20260517_dashboard_stats_rpc.sql

# useQuery appears in Index.tsx
grep -n "useQuery" src/pages/Index.tsx
# Expected: 3+ occurrences (sessions, dashboardStats, generalStats queries)
```
</verification>

<success_criteria>
All of the following must be true:

- [ ] `npx tsc --noEmit` exits with code 0 (zero TypeScript errors)
- [ ] `grep getSessionFlags src/pages/Index.tsx` returns no output (N+1 eliminated)
- [ ] `grep getFlagsForSessions src/pages/HistoryPage.tsx` returns 1+ lines (batch call present)
- [ ] `supabase/migrations/20260517_dashboard_stats_rpc.sql` exists and contains `CREATE OR REPLACE FUNCTION get_dashboard_stats`
- [ ] Dashboard in browser: Network tab shows 3 or fewer Supabase API calls on initial load for a car with 20 sessions (down from 20+)
- [ ] History page: Network tab shows 1 call to `session_flags` for the list (not 50 parallel calls)
- [ ] Session with >1000 rows shows truncation warning toast in History page detail view
- [ ] No runtime JavaScript errors in console on dashboard load
</success_criteria>

<output>
After all tasks and the checkpoint are complete, create:
`.planning/phases/04-performance-optimization/04-01-SUMMARY.md`

Include:
- What was built (each file changed, why)
- Key decisions (e.g., why RPC over view, why staleTime=30s)
- Any deviations from this plan and the reason
- Actual DB call count before vs after (from Network tab)
</output>
