# Codebase Concerns

**Analysis Date:** 2026-05-29

---

## Migration Drift

**One local migration has no remote counterpart:**
- Issue: Migration `20260526000000_grant_admin_skale_club.sql` appears locally but has no remote timestamp match. The `supabase migration list` output shows a blank Remote column for one of the two `20260526000000` entries.
- Files: `supabase/migrations/20260526000000_grant_admin_skale_club.sql`, `supabase/migrations/20260526000000_app_icons_bucket.sql`
- Cause: Two migration files share the same timestamp prefix (`20260526000000`). Supabase CLI uses the timestamp as a unique key; when two files collide, only one is tracked remotely.
- Fix approach: Rename one file to a later timestamp (e.g., `20260526000000_app_icons_bucket.sql` → `20260526000001_app_icons_bucket.sql`) and run `supabase db push` to reconcile.

---

## Security Considerations

**`/setup-admin` route is public and unauthenticated:**
- Risk: Any visitor can navigate to `/setup-admin`, read the admin email (`VITE_ADMIN_EMAIL`), and attempt to reset the admin password using `VITE_ADMIN_PASSWORD`. Both are Vite env vars baked into the client bundle, making them visible in the build output.
- Files: `src/pages/SetupAdminPage.tsx:10-11`, `src/App.tsx:64`
- Current mitigation: The admin password is read from `VITE_ADMIN_PASSWORD`; if that env var is empty (production), the page is inert.
- Recommendations: Gate the route behind an IP allowlist or Supabase auth check. Remove the `VITE_ADMIN_PASSWORD` reference from the rendered UI at lines 273 and 324 of `SetupAdminPage.tsx` — it outputs the password in plaintext HTML.

**Admin API key stored in `app_settings` table, readable by the frontend client:**
- Risk: `listAdminSettings()` in `src/lib/db-extras.ts:238` queries `app_settings` for the Gemini API key (`admin_secret_gemini_api_key`) using the standard Supabase browser client. Even if the row is marked `is_secret: true` in the JS constant, the actual DB column contains the plaintext key and is readable by any authenticated user who queries `app_settings` with `user_id IS NULL`.
- Files: `src/lib/db-extras.ts:238-255`, `src/pages/AdminPage.tsx`
- Current mitigation: RLS `"app_settings_own_user"` restricts writes to `user_id = auth.uid()`. Global settings (`user_id IS NULL`) are readable by `"Public read non-secret system settings"` policy.
- Recommendations: Move secret admin settings to Supabase Edge Function environment variables (`GEMINI_API_KEY`) rather than the `app_settings` table. The edge functions already use `supabase/functions/_shared/admin-config.ts` for this purpose.

**`session-photos` bucket uses `getPublicUrl()` despite the bucket being private:**
- Risk: `getPhotoUrl()` in `src/lib/db-extras.ts:118-121` calls `getPublicUrl()` on the `session-photos` bucket, which is created with `public: false` in `supabase/migrations/20260517160000_session_photos.sql:44`. The returned URL generates a public-formatted URL that returns 403 at runtime — photos never actually display.
- Files: `src/lib/db-extras.ts:118-121`, `src/components/PhotoUpload.tsx:134`
- Recommendations: Replace `getPublicUrl` with `createSignedUrl` (e.g., 3600s TTL) for the private bucket, or change the bucket to `public: true` if photos are intentionally shareable.

**Hardcoded production user UUID in a committed migration:**
- Risk: `supabase/migrations/20260527000004_seed_skale_mcp_token.sql:19` contains a hardcoded user UUID (`3938f132-37b3-484f-afd6-e068eb48ed6d`) for the admin account. This seeds a live MCP token tied to a production user ID. Any future deployment to a new Supabase project will silently fail the insert.
- Files: `supabase/migrations/20260527000004_seed_skale_mcp_token.sql`
- Recommendations: Delete the seed row from the migration; issue MCP tokens through the app UI only.

---

## Performance Bottlenecks

**N+1 query pattern on the dashboard (up to 20 sequential DB round-trips):**
- Problem: `src/pages/Index.tsx:175-193` loops over up to 20 sessions and calls `getSessionFlags(session.id)` individually inside a `for...of await` loop. This fires up to 20 sequential PostgREST requests per dashboard load.
- Files: `src/pages/Index.tsx:175-193`
- Cause: The loop was written for correctness without batching.
- Improvement path: Replace with the existing `getFlagsForSessions(sessionIds)` batch function (already available in `src/lib/db.ts:75`). Alternatively, call the `getDashboardStats()` RPC (`src/lib/db-extras.ts:178`) which computes health score server-side in a single query — note this function is exported but never called anywhere in the UI.

**N+1 pattern in HistoryPage flag counts (up to 50 concurrent DB requests):**
- Problem: `src/pages/HistoryPage.tsx:115-123` runs `Promise.all` over up to 50 sessions, each calling `getSessionFlags(session.id)`. While parallel, this is still 50 concurrent PostgREST requests per page load.
- Files: `src/pages/HistoryPage.tsx:115-123`
- Improvement path: Call `getFlagsForSessions(s.slice(0, 50).map(s => s.id))` once, then group results by `session_id` on the client.

**`get_dashboard_stats` RPC exists but is dead code in the UI:**
- Problem: The `getDashboardStats` function in `src/lib/db-extras.ts:178` wraps the `get_dashboard_stats` Postgres RPC (which computes recency-weighted health scores server-side in a single query), but it is never imported or called anywhere in the frontend.
- Files: `src/lib/db-extras.ts:178-192`, `src/pages/Index.tsx:148-219`
- Impact: The server-side optimized path exists but is bypassed; the dashboard always takes the slow N+1 path.

**`getSession(id)` fetches the full raw CSV via `select('*')`:**
- Problem: `src/lib/db.ts:57-64` uses `select('*')` for single-session fetches, which includes the `source_csv TEXT` column that can be megabytes of raw CSV data. This fires on every session detail view in `src/pages/SessionDetail.tsx:43` and `src/pages/HistoryPage.tsx:144`.
- Files: `src/lib/db.ts:57-64`, `src/pages/SessionDetail.tsx:43`, `src/pages/HistoryPage.tsx:144`
- Improvement path: Create a named select list for `getSession()` that excludes `source_csv`, and fetch that column separately only when the CSV download action is triggered.

---

## Tech Debt

**Widespread `as never` and `as unknown as X` type assertions masking Supabase type mismatches:**
- Issue: 82 occurrences of `as never` or `as unknown as` across `src/lib/db-extras.ts`, `src/lib/db.ts`, `src/lib/chat/db.ts`, and `src/hooks/use-csv-upload.ts`. The generated Supabase types in `src/integrations/supabase/types.ts` are out of sync with the actual schema — tables added after initial type generation (`maintenance_events`, `session_photos`, `shared_reports`, `vehicle_issues`, `vehicle_rulesets`) are not reflected.
- Files: `src/lib/db-extras.ts` (most instances), `src/lib/db.ts`, `src/lib/chat/db.ts`
- Impact: TypeScript provides no type safety for these DB interactions; bugs in column names or types go undetected until runtime.
- Fix approach: Regenerate types via `npx supabase gen types typescript --linked > src/integrations/supabase/types.ts`, then remove `as never` casts.

**`HistoryPage.tsx` and `SessionDetail.tsx` use hardcoded `DEFAULT_PRIUS_RULES` for all cars:**
- Issue: `src/pages/HistoryPage.tsx:148` always sets chart rules to `DEFAULT_PRIUS_RULES`. `src/pages/SessionDetail.tsx:77,214` also hardcodes `DEFAULT_PRIUS_RULES` for flag re-evaluation and chart display. The `resolveRulesetForCar()` function exists and is used correctly during upload but is never called when viewing existing sessions.
- Files: `src/pages/HistoryPage.tsx:148`, `src/pages/SessionDetail.tsx:77,214`
- Impact: Non-Prius vehicles see Prius-specific thresholds in their session charts and re-evaluation.
- Fix approach: Read `session.summary.rulesetId` (stored at upload time) and use it to load the correct rules via `resolveRulesetForCar()`.

**Diagnostic-only migrations committed to migration history:**
- Issue: Three migrations contain only `DO $$ ... RAISE NOTICE ... $$` diagnostic blocks with no schema changes: `20260526000002_debug_car_profiles.sql`, `20260527000005_diagnose_skale_state.sql`, `20260526000005_diagnose_full_state.sql`. These run on every `supabase db reset`.
- Files: `supabase/migrations/20260526000002_debug_car_profiles.sql`, `supabase/migrations/20260527000005_diagnose_skale_state.sql`, `supabase/migrations/20260526000005_diagnose_full_state.sql`
- Impact: Clutters migration history; `RAISE NOTICE` output during `db reset` may confuse future developers. Cannot be safely removed once applied remotely.

**`electric` engine type falls back to Tesla Model 3 rules:**
- Issue: `src/lib/rule-resolver.ts:59` uses `TESLA_MODEL3_RULES` as the fallback for `engine_type = 'electric'`. Any non-Tesla EV gets Tesla-specific OBD2 thresholds.
- Files: `src/lib/rule-resolver.ts:57-62`
- Fix approach: Create a `GENERIC_ELECTRIC_RULES` ruleset or let `electric` fall through to generic petrol.

**Tesla Model 3 rules acknowledge non-standard OBD2 without graceful fallback:**
- Issue: `src/lib/default-rules/tesla-model3.ts:7` notes that Tesla's OBD2 is non-standard and requires a Tesla-specific adapter. The ruleset proceeds with standard OBD2 parameter names that Teslas do not expose, resulting in rules that never fire or fire incorrectly.
- Files: `src/lib/default-rules/tesla-model3.ts`

**React Query is installed but not used for data fetching:**
- Issue: `@tanstack/react-query` `QueryClient` is set up in `src/App.tsx:5`, but all data fetching across pages uses raw `useEffect + useState`. The `QueryClient` is only used for cache invalidation in `AppSidebar.tsx` and `OnboardingWizard.tsx`. No `useQuery` or `useMutation` hooks are present.
- Files: `src/App.tsx:5,33`
- Impact: No caching, deduplication, or automatic background refetch; each navigation re-fetches everything.

---

## Missing Error Boundaries

**No React error boundaries anywhere in the component tree:**
- Issue: A search for `ErrorBoundary` returns zero results in `src/`. Any uncaught render error in a child component (e.g., a malformed `summary` JSONB crashing a chart) will unmount the entire application with a blank screen.
- Files: `src/App.tsx` (no boundary around routes), `src/components/DashboardCharts.tsx`, `src/components/SessionCharts.tsx`
- Impact: A single bad data record can crash the entire app for that user.
- Fix approach: Wrap each page route in a class-based `ErrorBoundary` with a fallback UI. Priority: `Index`, `HistoryPage`, `SessionDetail`, `DashboardCharts`.

---

## Fragile Areas

**`src/pages/Index.tsx` is 708 lines — monolithic dashboard component:**
- Files: `src/pages/Index.tsx`
- Why fragile: Contains data loading, stats calculation (including inline fuel efficiency math with multiple unit conversions and ambiguity noted in comments at lines 252-258), three Dialog components, chart data preparation, and realtime subscription logic. The `calculateGeneralStats` effect spans lines 222-350.
- Safe modification: Extract the `calculateGeneralStats` effect to a custom hook. Extract the Problems Dialog (lines 589-680) to a separate component.
- Test coverage: None.

**`src/lib/csv-parser.ts` — heuristic column detection with no tests:**
- Files: `src/lib/csv-parser.ts`
- Why fragile: Relies on fuzzy header matching (normalize + substring). New Car Scanner firmware versions that change column naming will silently produce empty summaries rather than failing explicitly.
- Test coverage: None.

**Core analysis pipeline has no automated tests:**
- Files: `src/lib/insight-engine.ts`, `src/lib/report-generator.ts`, `src/lib/csv-parser.ts`, `src/lib/rule-resolver.ts`, `src/lib/issue-reconciler.ts`
- Why fragile: The primary value-generating code paths — CSV parsing, flag evaluation, health scoring, report generation, issue reconciliation — run client-side with zero test coverage.
- Priority: High.

---

## Test Coverage Gaps

**Only one test file exists; it is a placeholder:**
- What's not tested: CSV parsing, OBD2 parameter rule evaluation, health score calculation, session flag insertion, fuel efficiency calculation, ruleset resolution, report generation, issue reconciliation, OAuth PKCE flow.
- Files: `src/test/example.test.ts` (single `expect(true).toBe(true)` test)
- Risk: Any change to parsing or rule thresholds can silently break analysis for all users.
- Priority: High.

---

## Scaling Limits

**`user_quotas` table uses probabilistic cleanup (1% chance per insert):**
- Files: `supabase/migrations/20260528100000_security_hardening.sql:99-116` (`prune_old_user_quotas` trigger)
- Current capacity: Rows are kept 14 days; cleanup fires ~1% of inserts.
- Limit: Under sustained load the table accumulates rows much faster than cleanup removes them.
- Scaling path: Replace probabilistic trigger with a `pg_cron` scheduled job that runs `DELETE ... WHERE created_at < now() - INTERVAL '14 days'` nightly.

**`session_rows` JSONB `data` column — no key-level index:**
- Files: `supabase/migrations/20260206193301_820f8520-db2f-4ded-a40a-5eab76b49b13.sql:30-40`
- Current capacity: 2000 rows per session; queries filter by `session_id` (indexed). Server-side queries that filter by sensor value within `data` require full table scans.
- Scaling path: Add GIN or expression indexes on frequently queried JSONB keys if server-side aggregation queries are added.

---

## Dependencies at Risk

**Supabase CLI is significantly outdated:**
- Risk: Installed version `v2.76.6`; current release is `v2.102.0` (flagged in `supabase migration list` output). Over 25 minor versions behind.
- Impact: Potential incompatibilities with newer Supabase platform features; security and bug fix patches missed.
- Migration plan: Run `npx supabase update` or `npm install -g supabase@latest`.

---

*Concerns audit: 2026-05-29*
