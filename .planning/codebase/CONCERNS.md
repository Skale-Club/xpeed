# Codebase Concerns

**Analysis Date:** 2026-05-17

---

## Security Considerations

### [CRITICAL] Gemini API Key Stored Plaintext in Database

- Risk: User's Google Gemini API key is persisted as a plain `TEXT` field in the `app_settings` table with `encrypted: false` explicitly set in code. Any data breach, misconfigured RLS policy, or support access to the Supabase dashboard exposes all user API keys.
- Files: `src/lib/db.ts` lines 327–345, `supabase/migrations/20260209095500_gemini_integration.sql`
- Current mitigation: RLS restricts reads to the owning user (`auth.uid() = user_id`), and the UI masks the key with bullet characters after save. A code comment acknowledges the risk: `// Note: In production, consider encrypting this`.
- Recommendations: Encrypt the value with `pgcrypto` before insert (AES-256 with a server-side secret), or move key storage entirely to the browser (`localStorage`) so it never reaches the database. The column already has an `encrypted` boolean column — it is never set to `true`.

### [HIGH] `app_settings` Initial Migration Has No User Isolation

- Risk: The very first migration (`20260209095500_gemini_integration.sql`) creates `app_settings` with `UNIQUE(setting_key)` and a permissive `"Allow all access"` policy. A second migration (`20260209105600_auth_setup.sql`) later adds `user_id` and fixes RLS, but the original `UNIQUE` constraint on `setting_key` alone means a second user saving `gemini_api_key` would fail with a unique-violation until the constraint was changed to `UNIQUE(setting_key, user_id)`. The migration that adds `user_id` does not explicitly drop and recreate the unique constraint — this is a migration ordering risk if the database was provisioned at any intermediate state.
- Files: `supabase/migrations/20260209095500_gemini_integration.sql`, `supabase/migrations/20260209105600_auth_setup.sql`
- Current mitigation: Current `upsert` in `db.ts` uses `onConflict: 'setting_key,user_id'` suggesting the composite unique constraint exists in production.
- Recommendations: Explicitly document and verify that the composite unique index is present in production. Add a migration guard.

### [MEDIUM] Admin Check via `is_admin` Column on `car_profiles` Table

- Risk: The `is_admin` field lives on `car_profiles`, not on a dedicated user-role table. The `is_admin()` DB function checks any car profile row for the user — a user who creates a car profile row and somehow sets `is_admin = true` (via a permissive migration state or timing gap) would gain admin access. The admin SELECT policy runs `public.is_admin(auth.uid())` which itself queries `car_profiles` — tables with RLS policies that also have RLS-bypass admin policies create a recursive evaluation risk.
- Files: `supabase/migrations/20260209110700_admin_support.sql`, `src/lib/db.ts` lines 385–396
- Current mitigation: RLS on `car_profiles` prevents users from updating their own `is_admin` flag directly.
- Recommendations: Move admin status to a separate `user_roles` table or use Supabase's built-in `user_metadata`/`app_metadata` claims set by a server-side function.

### [MEDIUM] `chat_conversations` INSERT Policy Requires Client to Supply `user_id` With No Auto-Trigger

- Risk: The RLS INSERT policy is `WITH CHECK (auth.uid() = user_id)`. The `createConversation()` function in `src/lib/chat/db.ts` does not pass `user_id` in the insert payload — it relies on a database trigger or default. No trigger exists on `chat_conversations` to set `user_id` automatically (unlike `car_profiles` and `sessions` which have `set_user_id` triggers). If the trigger is absent in a given environment, `user_id` will be `NULL`, the INSERT CHECK will fail, and conversation creation will silently throw an RLS error.
- Files: `src/lib/chat/db.ts` lines 84–98, `supabase/migrations/20260308_chat_system.sql`
- Current mitigation: None — no auto-set trigger exists for `chat_conversations`.
- Recommendations: Add a `BEFORE INSERT` trigger using `public.set_user_id()` on `chat_conversations`, or explicitly pass `user_id: (await supabase.auth.getUser()).data.user?.id` in the insert payload.

---

## Performance Bottlenecks

### [HIGH] N+1 Query Pattern in Dashboard (`Index.tsx`)

- Problem: The dashboard fetches up to 20 sessions and then issues one `getSessionFlags()` Supabase query per session inside a `for...of` loop (with `await` inside the loop). This results in up to 20 sequential round-trips to the database on every dashboard load and on every date-range filter change.
- Files: `src/pages/Index.tsx` lines 131–150
- Cause: Each iteration `await`s `getSessionFlags(session.id)` individually instead of using the existing batch function.
- Improvement path: Replace the loop with a single call to `getFlagsForSessions(sessionsForTrend.map(s => s.id))` which already exists in `src/lib/db.ts` and uses `.in('session_id', sessionIds)`. Results can be grouped by `session_id` client-side.

### [HIGH] N+1 Query Pattern in History Page (`HistoryPage.tsx`)

- Problem: On load, `HistoryPage` fetches the session list then fires `Promise.all` over up to 50 sessions, each calling `getSessionFlags(session.id)`. While `Promise.all` parallelises them, it still opens up to 50 simultaneous HTTP connections to Supabase. On the free tier this saturates the connection pool and causes intermittent failures or high latency.
- Files: `src/pages/HistoryPage.tsx` lines 100–109
- Cause: Same pattern — `getSessionFlags` called per session instead of using `getFlagsForSessions`.
- Improvement path: Replace the `Promise.all` block with a single `getFlagsForSessions(s.map(s => s.id))` call, then group results by `session_id` client-side.

### [MEDIUM] `getSessionRows()` Hard-Coded 1000-Row Limit with Silent Truncation

- Problem: `getSessionRows` always returns at most 1000 rows. OBD2 sessions recorded at 1 Hz for 20 minutes already exceed this limit (1200 rows). Any session longer than approximately 16 minutes silently loses data when displaying charts and re-computing flags. The caller has no way to know truncation occurred.
- Files: `src/lib/db.ts` lines 71–79, `src/pages/HistoryPage.tsx` line 129, `src/pages/SessionDetail.tsx` line 35
- Cause: Supabase client default is 1000 rows; `.limit(1000)` is explicit but no count check or warning exists.
- Improvement path: Add a `count: 'exact'` option to detect truncation and surface a UI warning when `row_count > 1000`, or implement cursor-based pagination using `range()`.

### [MEDIUM] Chat `buildChatContext` Fetches All Sessions Before Slicing to 5

- Problem: `buildChatContext` calls `getSessions(carProfileId)` which returns all sessions for the car (up to PostgREST's 1000-row default). The result is then sliced to 5 client-side. For a user with many sessions, hundreds of session records are transferred over the network before being discarded.
- Files: `src/lib/chat/db.ts` lines 221–227
- Cause: `getSessions()` has no `limit` parameter.
- Improvement path: Add an optional `limit` parameter to `getSessions()` and pass `limit: 5` from `buildChatContext`.

### [LOW] Chat Context Serialised as Full JSON in System Prompt

- Problem: `handleSendMessage` embeds `JSON.stringify(contextData, null, 2)` into the Gemini system prompt on every call. `recentSessions` entries include the full `summary` JSONB blob from the database, which can be large, inflating every API call and consuming unnecessary Gemini input tokens.
- Files: `src/components/chat/ChatContainer.tsx` lines 144–150
- Improvement path: Strip `summary` from context entries before serialisation; pass only `date`, `filename`, and `duration`.

---

## Tech Debt

### [HIGH] Pervasive `any` Type Usage Across 12 Files (44 Occurrences)

- Issue: 44 occurrences of `: any`, `as any`, or bare `any` spread across 12 source files. This defeats TypeScript's purpose in the highest-complexity parts of the codebase (CSV parsing, session flags, dashboard stats).
- Files: `src/pages/Index.tsx` (6), `src/pages/HistoryPage.tsx` (12), `src/pages/SessionDetail.tsx` (7), `src/components/LatestTripCard.tsx` (6), `src/components/DashboardCharts.tsx` (5), `src/lib/db.ts` (2), `src/lib/csv-parser.ts` (1), `src/lib/gemini-service.ts` (1), `src/contexts/AuthContext.tsx` (1), `src/pages/LoginPage.tsx` (1), `src/pages/SettingsPage.tsx` (1), `src/components/SessionCharts.tsx` (1)
- Impact: Type errors in session data shape, flag structure, and summary JSONB go undetected at compile time. Refactoring is unsafe.
- Fix approach: Define concrete interfaces for `Session`, `SessionFlag`, `SessionRow`, and `SessionSummary` in a shared `src/types/` module. Replace `any` with these types or `unknown` with runtime guards.

### [HIGH] `as unknown as never` Casts for JSONB Insert Columns

- Issue: Five insert/update operations in `src/lib/db.ts` use `as unknown as never` to satisfy the Supabase-generated type for JSONB columns (`columns`, `summary`, `data`, `evidence`, `gemini_analysis`). This fully silences the type checker for those values.
- Files: `src/lib/db.ts` lines 134, 135, 247, 267, 365
- Impact: Any shape mismatch between what is inserted and what the schema expects will not be caught until runtime.
- Fix approach: Regenerate Supabase types with `supabase gen types typescript` after each schema migration, or manually override the generated JSONB column types with explicit `Json`-compatible mapped types.

### [MEDIUM] `insertSessionRows` Silently Ignores Insert Errors

- Issue: Each chunk insert inside `insertSessionRows` does not check the returned `error` from Supabase. A failed chunk (due to RLS, network, or constraint violation) is silently skipped, resulting in partial session data with no feedback to the caller or user.
- Files: `src/lib/db.ts` lines 249–253
- Impact: Sessions can appear to have uploaded successfully while missing significant portions of their time-series data.
- Fix approach: Destructure `{ error }` from each insert result and either throw immediately or accumulate errors to report after the loop.

### [MEDIUM] `insertSessionFlags` Silently Ignores Insert Errors

- Issue: Same pattern as `insertSessionRows` — the `.insert(rows)` call result is never checked or awaited with error handling.
- Files: `src/lib/db.ts` line 269
- Impact: Flags can silently fail to persist, causing the dashboard to show a healthy score for sessions that actually have issues.
- Fix approach: Destructure `{ error }` and throw on failure.

### [MEDIUM] `getDefaultCarProfile()` Creates Hardcoded Profile Without `user_id`

- Issue: `getDefaultCarProfile()` inserts a profile named `"2010 Prius"` with notes `"Toyota Prius Gen 3"` if no profile exists. It has no callers in `src/` (dead code), but if it were ever called it would attempt an insert without a `user_id`. The `set_car_profiles_user_id` trigger would auto-populate `user_id` only if called from an authenticated context. If called unauthenticated, `auth.uid()` returns `NULL` and the record becomes inaccessible due to RLS.
- Files: `src/lib/db.ts` lines 18–27
- Fix approach: Remove the function or update it to accept a `userId` parameter and pass a generic profile name.

### [LOW] Auth Loading State Race Condition in `AuthContext`

- Issue: `AuthContext` initialises with `loading: true`, calls `getSession()` asynchronously, and separately subscribes to `onAuthStateChange`. Between mount and the `getSession().then(...)` callback resolving, `onAuthStateChange` can fire (e.g., from a stored token being validated), setting `user` before `loading` is set to `false`. The `loading` flag is only ever set to `false` inside the `getSession` callback — not in the `onAuthStateChange` handler. Any component using `loading` to gate a redirect can briefly show unauthenticated UI even when a session exists.
- Files: `src/contexts/AuthContext.tsx` lines 23–38
- Impact: Potential flash of login screen or incorrect redirect on hard reload with an active session.
- Fix approach: Follow Supabase's recommended pattern — derive the initial session state from the `INITIAL_SESSION` event inside `onAuthStateChange`, and set `loading(false)` only there, removing the separate `getSession()` call.

### [LOW] `resolved` Column Missing From Generated TypeScript Types

- Issue: The `resolved` column was added to `session_flags` via a standalone migration after the initial schema. `toggleFlagResolved` uses `as any` with the comment `// TODO: Update types when column is official`, indicating Supabase-generated types have not been regenerated to include this column.
- Files: `src/lib/db.ts` line 279, `supabase/migrations/20260209182800_add_resolved_to_flags.sql`
- Impact: No TypeScript safety for the `resolved` field anywhere it is read or written throughout the codebase.
- Fix approach: Run `supabase gen types typescript --project-id <id> > src/integrations/supabase/types.ts` to regenerate types and remove the `as any` cast.

### [LOW] `@ts-ignore` and `as any` for `Intl.supportedValuesOf`

- Issue: `SettingsPage.tsx` uses `// @ts-ignore` and `(Intl as any)` to call `Intl.supportedValuesOf('timeZone')` because the TypeScript lib target does not include this method.
- Files: `src/pages/SettingsPage.tsx` line 33
- Fix approach: Add `"ES2022"` or `"ES2022.Intl"` to the `lib` array in `tsconfig.json`, or add a local `declare` statement for the method.

### [LOW] `window.location.href` Navigation Inside React Router App

- Issue: `ChatContainer.tsx` uses `window.location.href = '/settings'` for navigation instead of the React Router `useNavigate` hook. This causes a full page reload, losing all in-memory React state including the current conversation.
- Files: `src/components/chat/ChatContainer.tsx` line 310
- Fix approach: Import and call `useNavigate()` from `react-router-dom`.

### [LOW] `deleteMessagesFrom` Uses Timestamp Comparison for Deletion

- Issue: `deleteMessagesFrom` deletes all chat messages where `created_at >= message.created_at`. If two messages share the same timestamp (possible with fast inserts), the wrong messages may be deleted.
- Files: `src/lib/chat/db.ts` lines 172–196
- Fix approach: Delete by message ID using a cursor-ordered subquery, or accept an array of message IDs to delete directly.

---

## Schema / Migration Concerns

### [HIGH] `car_profiles` Initially Had No `user_id`, Allowing Cross-User Access

- Issue: The initial migration (`20260206193301`) created `car_profiles` with a permissive `"Allow all access"` policy and no `user_id` column. User isolation was retrofitted in `20260209104400_multi_car_support.sql`. Any profile created before that migration has `user_id = NULL` and falls through the updated RLS policies (which require `auth.uid() = user_id`), making those rows invisibly inaccessible to their owners. The migration attempts a best-effort `UPDATE` from `sessions.user_id` but this succeeds only if `sessions.user_id` was already populated.
- Files: `supabase/migrations/20260206193301_820f8520-db2f-4ded-a40a-5eab76b49b13.sql`, `supabase/migrations/20260209104400_multi_car_support.sql`
- Impact: Legacy profiles with `user_id = NULL` are silently invisible to their owners after the RLS migration.
- Fix approach: Run an audit query to identify `car_profiles WHERE user_id IS NULL` in production and manually assign them, or add a fallback RLS policy covering null `user_id` rows for a defined transition period.

### [MEDIUM] `chat_messages` RLS Uses `IN` Subquery Per Row

- Issue: The SELECT and INSERT policies on `chat_messages` use `conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = auth.uid())`. PostgreSQL re-evaluates this subquery for every row scanned during a policy check, which becomes expensive as message volumes grow.
- Files: `supabase/migrations/20260308_chat_system.sql` lines 49–68
- Note: An index `idx_chat_conversations_user` on `chat_conversations(user_id)` exists and mitigates this somewhat.
- Improvement path: Rewrite as an `EXISTS` form: `EXISTS (SELECT 1 FROM chat_conversations cc WHERE cc.id = chat_messages.conversation_id AND cc.user_id = auth.uid())`, which the query planner handles more efficiently, or denormalize `user_id` onto `chat_messages` with a trigger.

---

## Test Coverage Gaps

### [CRITICAL] No Application Tests Exist

- What's not tested: All business logic — CSV parsing, flag evaluation rules, session health scoring algorithm, fuel efficiency calculations, Gemini API integration, auth flows, all database functions in `src/lib/db.ts` and `src/lib/chat/db.ts`.
- Files: `src/test/example.test.ts` — the only test file in the project; contains a single placeholder assertion (`expect(true).toBe(true)`).
- Risk: Silent regressions in the health score calculation (`src/pages/Index.tsx` lines 136–152), CSV column mapping (`src/lib/csv-parser.ts`), and flag severity logic (`src/lib/insight-engine.ts`) are entirely undetectable without manual testing.
- Priority: High. Start with `src/lib/insight-engine.ts` (flag evaluation), `src/lib/csv-parser.ts`, and the scoring algorithm in `Index.tsx`.

---

## Fragile Areas

### `src/pages/Index.tsx` — Fuel Efficiency Calculation

- Files: `src/pages/Index.tsx` lines 229–285
- Why fragile: The fuel calculation uses a heuristic (`rate < 2.5` → gallons/hour, else liters/hour) to infer OBD2 PID units. This depends on Car Scanner exporting PIDs with consistent naming across vehicle makes — which is not guaranteed. Inline comments show uncertainty about unit handling: `"Note: We calculate in KM first (base unit), then convert at display time OR we can convert here..."`. Unit conversion is done mid-computation and interleaved with conditional accumulation.
- Safe modification: Any change to fuel/distance unit logic requires testing against known CSV samples covering both metric and imperial configurations. Do not modify without adding unit tests first.
- Test coverage: Zero.

### `src/lib/db.ts` — `updateSession()` Accepts Unrestricted `Record<string, any>`

- Files: `src/lib/db.ts` lines 108–115
- Why fragile: The `updates` parameter is typed as `Record<string, any>`, allowing any arbitrary key-value pair to be written to the `sessions` table with no compile-time validation. A typo in a field name silently updates nothing (Supabase ignores unknown columns in typed clients) or, in untyped fallback, updates an unintended column.
- Safe modification: Replace `Record<string, any>` with `Partial<Pick<Session, 'source_filename' | 'gemini_analysis' | 'summary'>>` using a concrete `Session` interface once the `any` cleanup is done.

---

*Concerns audit: 2026-05-17*
