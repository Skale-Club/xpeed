# Architecture

**Analysis Date:** 2026-05-29

## Pattern Overview

**Overall:** Client-heavy SPA with Supabase BaaS backend + Deno Edge Functions for server-side AI/OAuth logic

**Key Characteristics:**
- All data access goes through a thin `src/lib/` layer that wraps the Supabase JS client — no Supabase calls in components
- React Context provides global state (auth, cars, settings); no Zustand or Redux
- All AI calls (Gemini) are proxied through Edge Functions — the API key never leaves the server
- OBD2 session analysis pipeline runs entirely client-side (CSV parse → rule evaluation → flag insert), then AI analysis is requested server-side

## Layers

**UI Layer (Pages):**
- Purpose: Route-level page components, orchestrate data loading and user interaction
- Location: `src/pages/`
- Contains: Index (dashboard), SessionDetail, CarsPage, HistoryPage, MaintenancePage, VehicleIssuesPage, AdminPage, SettingsPage, OnboardingPage, SharedReport, OAuthAuthorize, LoginPage, SignupPage, SetupAdminPage, ShareImportPage
- Depends on: Context layer, lib layer, UI components
- Used by: React Router routes defined in `src/App.tsx`

**Context Layer:**
- Purpose: Global reactive state shared across the component tree
- Location: `src/contexts/`
- Contains:
  - `AuthContext.tsx` — Supabase session, user object, signIn/signOut/signInWithGoogle/resetPassword
  - `CarsContext.tsx` — thin wrapper over `use-cars.ts` hook, exposes cars[], selectedCar, CRUD operations
  - `SettingsContext.tsx` — distanceUnit + timezone, persisted in localStorage
- Depends on: `src/integrations/supabase/client.ts`, `src/lib/db.ts`
- Used by: All authenticated pages and the `PrivateRoute` guard

**Data Access Layer:**
- Purpose: All Supabase read/write operations — components never call supabase directly
- Location: `src/lib/db.ts`, `src/lib/db-extras.ts`, `src/lib/db-issues.ts`, `src/lib/chat/db.ts`
- Contains:
  - `db.ts` — sessions, session_rows, session_flags, car_profiles, app_settings (AI model), CSV storage
  - `db-extras.ts` — maintenance_events, session_photos, shared_reports, dashboard stats RPC (`get_dashboard_stats`), admin settings, vehicle_issues (v2 schema), parameter_baselines
  - `db-issues.ts` — vehicle_issues (v1 schema with different severity/status enums, used by issue-reconciler)
  - `chat/db.ts` — chat_conversations, chat_messages, `buildChatContext()` which aggregates sessions + trends + maintenance for AI context
- Depends on: `src/integrations/supabase/client.ts`
- Used by: hooks, page components, AI client

**Business Logic Layer:**
- Purpose: OBD2 analysis pipeline, rule engine, report generation, trend analysis
- Location: `src/lib/`
- Key modules:
  - `csv-parser.ts` — parses OBD2 CSV files, detects delimiter (comma vs semicolon), maps columns to canonical keys, extracts DTCs
  - `canonical-params.ts` — maps OBD2 column names to canonical parameter keys (e.g. "Coolant Temp" → `coolant_temp`)
  - `insight-engine.ts` — `computeParameterSummaries()` and `evaluateRules()`: runs parameter rules against session rows, produces SessionFlags with evidence
  - `rule-resolver.ts` — selects the correct ruleset for a car: most-specific match first (make+model+year), then engine_type fallback, then generic petrol
  - `default-rules/` — static bundled rulesets: Toyota Prius, Honda Civic G10, Ford F-150, Subaru WRX, Tesla Model 3, generic petrol/hybrid/diesel
  - `report-generator.ts` — assembles `SessionReport` struct (vehicle + session + diagnostics + parameters); versioned via `PROCESSING_VERSION`
  - `issue-reconciler.ts` — after flags are saved, upserts `vehicle_issues` and `vehicle_issue_occurrences` rows without deleting history
  - `trends.ts` — computes per-parameter trend signals (recent N vs historic M sessions) for AI chat context
  - `vehicle-library.ts` — fetches makes/models from NHTSA API, caches results in `vehicle_makes_cache` table
  - `downsample.ts` — downsamples session rows before insert to keep DB size manageable
  - `dtc-codes.ts` — DTC code lookup dictionary
  - `ai-client.ts` — client-side wrappers for `analyze-session` and `chat` Edge Functions via `supabase.functions.invoke()`
  - `mcp-tokens.ts` — CRUD for `mcp_tokens` table; tokens are SHA-256 hashed at rest
  - `brand.ts` — builds and uploads brand asset variants (favicon sizes, PWA icons, OG image) to `brand-assets` Storage bucket
- Depends on: `src/integrations/supabase/client.ts`, `src/lib/db.ts`

**Hook Layer:**
- Purpose: Encapsulate stateful data fetching and UI utilities
- Location: `src/hooks/`
- Key hooks:
  - `use-cars.ts` — fetches/creates/updates/deletes car profiles, manages selectedCarId in state
  - `use-csv-upload.ts` — full upload pipeline: parse → summaries → ruleset → flags → upload CSV → createSession → insertSessionRows → insertSessionFlags → generateReport → storeSessionReport → updateSessionVersioning → reconcileIssues → refreshParameterBaselines
  - `use-admin-status.ts` — calls `is_admin_user()` RPC, caches result per user in a module-level Map
  - `use-brand.ts` — loads brand config from `app_settings`, applies theme colors
  - `use-view-mode.ts` — toggles between simple/advanced view in dashboard and session detail
  - `use-app-icon.ts` — manages dynamic PWA app icon
  - `use-mobile.tsx` — mobile breakpoint detection

**AI / Edge Function Layer:**
- Purpose: Server-side AI logic with quota enforcement and API key isolation
- Location: `supabase/functions/`
- Functions:
  - `analyze-session/` — reads `sessions.report` JSON from DB, formats for Gemini, returns `{summary, key_findings, recommended_action}`; enforces 10 analyses/user/day
  - `chat/` — builds structured system prompt from vehicle context (sessions, DTCs, trends, maintenance), calls Gemini with conversation history; enforces 30 messages/user/day
  - `mcp-server/` — JSON-RPC 2.1 MCP endpoint; accepts Supabase JWT or MCP token; tools: listCars, getCar, listSessions, getSession, getSessionFlags, getSessionRows, getDtcInfo, searchDtcs, listMaintenance
  - `xpeed-oauth/` — OAuth 2.1 server (register, issue-code, token) with PKCE S256, HS256 JWT access tokens, opaque refresh tokens with rotation
  - `manage-mcp-tokens/` — MCP token lifecycle management
  - `car-insights-mcp/` and `xpeed-mcp/` — additional MCP variants
  - `_shared/admin-config.ts` — reads Gemini API key and model from `app_settings` DB table
  - `_shared/quota.ts` — per-user/day quota enforcement via `user_quotas` table (fails open on DB error)

**Vercel API Routes (Edge):**
- Purpose: Thin proxy shims and OAuth 2.1 discovery endpoints deployed as Vercel Edge Functions
- Location: `api/`
- Routes:
  - `api/oauth/issue-code.ts`, `register.ts`, `token.ts` — proxy requests to `xpeed-oauth` Supabase Edge Function
  - `api/wellknown/oauth-authorization-server.ts`, `oauth-protected-resource.ts` — OAuth 2.1 discovery metadata
  - `api/brand/manifest.ts` — generates dynamic PWA web manifest from brand config in DB
  - `api/mcp.ts` — MCP endpoint proxy

## Data Flow

**CSV Upload Pipeline:**

1. User selects file in `UploadCard` component (`src/components/UploadCard.tsx`)
2. `useCSVUpload` hook (`src/hooks/use-csv-upload.ts`) triggers:
   - `parseCSV()` — detects delimiter, maps columns to canonical keys, extracts DTCs
   - `computeParameterSummaries()` — min/max/avg/median per parameter
   - `resolveRulesetForCar()` — picks correct ruleset for the car's make/model/year
   - `evaluateRules()` — compares parameter values against thresholds, produces SessionFlags
   - `uploadSessionCSV()` — uploads raw CSV to `session-csv` Storage bucket at `{userId}/{carId}/{timestamp}-{uuid}-{filename}`
   - `createSession()` — inserts row into `sessions` table
   - `insertSessionRows()` — batch-inserts rows in chunks of 200 into `session_rows`
   - `insertSessionFlags()` — inserts flags into `session_flags`
   - `generateReport()` — assembles `SessionReport` struct (REPORT_VERSION + PROCESSING_VERSION stamped)
   - `storeSessionReport()` — saves report JSON to `sessions.report` (JSONB column)
   - `updateSessionVersioning()` — records ruleset_id + processing_version on session row
   - `reconcileIssues()` — upserts `vehicle_issues` + `vehicle_issue_occurrences` rows
   - `refreshParameterBaselines()` — calls `refresh_parameter_baselines` RPC for statistical baselines
3. `onComplete(sessionId)` callback triggers navigation to `/session/:id`

**AI Analysis Flow:**

1. `SessionDetail` page renders `AIAnalysisCard` component
2. User clicks "Analyze" → calls `analyzeSessionById(sessionId)` from `src/lib/ai-client.ts`
3. `supabase.functions.invoke('analyze-session', { body: { sessionId } })` forwards Supabase JWT automatically
4. Edge Function reads `sessions.report` from DB, formats it as a compact text block, sends to Gemini
5. Returns `{analysis: {summary, key_findings, recommended_action}}`
6. Result stored back via `updateSessionWithGeminiAnalysis()` in `sessions.gemini_analysis`

**Auth Flow:**

1. App mounts → `AuthProvider` calls `supabase.auth.getSession()` + subscribes to `onAuthStateChange`
2. `PrivateRoute` checks `user` from `AuthContext`; redirects to `/login` if null while loading shows spinner
3. Login: `supabase.auth.signInWithPassword()` or `signInWithOAuth({ provider: 'google', options: { redirectTo } })`
4. Supabase JWT stored in `localStorage` (persistSession: true, autoRefreshToken: true)
5. All subsequent Supabase calls carry the JWT automatically via the singleton client instance
6. Admin status checked once via `is_admin_user()` SECURITY DEFINER RPC, cached in module-level Map per user.id

**MCP / AI Agent Access Flow:**

1. External AI agent (Claude.ai, etc.) performs OAuth 2.1 PKCE flow: discovers metadata via `/.well-known/oauth-authorization-server`, registers client, user approves consent on `/oauth/authorize`, exchanges code for tokens via `api/oauth/token`
2. Access token (HS256 JWT, 1h TTL) or static MCP token sent as `Authorization: Bearer <token>`
3. `mcp-server` Edge Function: tries JWT auth first (Supabase user), falls back to MCP token hash lookup in `mcp_tokens` table
4. JSON-RPC 2.1 `tools/call` dispatches to service modules in `supabase/functions/mcp-server/services/`
5. Service modules query Supabase scoped to the authenticated user (RLS enforced)

## Key Abstractions

**SessionReport:**
- Purpose: Immutable computed snapshot of a session (vehicle + diagnostics + parameters), stored in DB
- Examples: `src/lib/report-generator.ts` (type `SessionReport`), stored in `sessions.report` (JSONB)
- Pattern: Generated at upload time, version-stamped, read by Edge Function for AI analysis

**DefaultRule / Ruleset:**
- Purpose: Per-vehicle-model threshold definitions for OBD2 parameters
- Examples: `src/lib/default-rules/` — 7 vehicle-specific rulesets + 3 generic fallbacks
- Pattern: Static TypeScript objects with `normal_min`, `normal_max`, `warn_*`, `critical_*`, `min_duration_seconds` per canonical key. `rule-resolver.ts` selects the most specific match.

**CanonicalKey:**
- Purpose: Normalize OBD2 column names across different scanner apps and CSV formats
- Examples: `src/lib/canonical-params.ts`
- Pattern: `matchCanonicalKey(columnName)` returns `{ canonical_key, label, unit }` or null; used in csv-parser to build `headerMapping`

**CarProfile:**
- Purpose: Vehicle identity record used for ruleset selection and data scoping
- Type definition: `src/lib/db.ts` (CarProfile, CarProfileInput)
- All session/flag/issue/maintenance data is scoped by `car_profile_id` via RLS

## Entry Points

**SPA Entry:**
- Location: `src/main.tsx`
- Responsibilities: Mounts React root, initializes i18n, registers `vite:preloadError` handler for chunk reload on Vercel redeploys

**App Router:**
- Location: `src/App.tsx`
- Responsibilities: Provider tree setup (QueryClientProvider → TooltipProvider → AuthProvider → SettingsProvider), lazy route definitions with `React.lazy()`
- Authenticated routes wrapped in `AuthenticatedLayout` (PrivateRoute + CarsProvider + Suspense)
- Public routes: `/login`, `/signup`, `/setup-admin`, `/oauth/authorize`, `/share/:id`

**Edge Function Entries:**
- Each `supabase/functions/<name>/index.ts` is a standalone Deno HTTP server using `serve()` from `https://deno.land/std@0.224.0/http/server.ts`

## Error Handling

**Strategy:** Errors thrown in lib/hook layers; caught and displayed via Sonner toast at page/component level

**Patterns:**
- `src/lib/db.ts` — throws `new Error(message)` on any Supabase error; descriptive messages include table names
- `src/lib/db-extras.ts` — non-fatal operations (baseline refresh, maintenance load) use `console.warn` and return empty arrays
- `src/hooks/use-csv-upload.ts` — full try/catch wraps the pipeline; on failure, cleans up created session and Storage file
- Edge Functions — return `{ error: string }` JSON with appropriate HTTP status; quota exceeded returns 429 with `remaining` + `limit` fields
- `src/lib/ai-client.ts` — AI calls return `null` on any failure (non-fatal, never throw to caller)

## Cross-Cutting Concerns

**Logging:** `console.error`/`console.warn` used directly; no structured logging library

**Validation:** Client-side only via TypeScript types + runtime checks in lib functions; no Zod or validation library

**Authentication:** Supabase Auth — JWT in localStorage; `PrivateRoute` guards all app routes; admin role via `is_admin_user()` SECURITY DEFINER RPC

**Internationalization:** `react-i18next` with locale files at `src/locales/` (en, pt-BR, es-ES); initialized in `src/lib/i18n.ts`, bootstrapped in `src/main.tsx`

**Quota Enforcement:** `user_quotas` table + `_shared/quota.ts` in Edge Functions; 10 analyses/day, 30 chat messages/day; fails open (allows through) on DB error

**Admin Privilege:** Determined by `car_profiles.is_admin = true` for a user's profile row; the column is locked from user mutation by a database trigger added in `20260527000001_lock_is_admin.sql`

**React Query:** `QueryClientProvider` wraps the app but is used only by `AppSidebar` (via `useQueryClient` for cache invalidation after car operations); most data fetching uses direct async calls in `useEffect`

---

*Architecture analysis: 2026-05-29*
