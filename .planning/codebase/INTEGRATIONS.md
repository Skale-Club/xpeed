# External Integrations

**Analysis Date:** 2026-05-17

## APIs & External Services

**Google Gemini AI:**
- Purpose: OBD2 session analysis and AI chat with vehicle context
- SDK/Client: `@google/generative-ai` 0.24 (`src/lib/gemini-service.ts`)
- Default model: `gemini-2.5-flash` (configurable; `gemini-2.0-flash` used for API key validation)
- Auth: User-provided API key stored in the `app_settings` Supabase table under the key `gemini_api_key`; NOT a build-time env var
- Functions exposed:
  - `analyzeSession(apiKey, sessionData, modelName?)` — sends OBD2 summary data, returns structured JSON `{summary, insights, recommendations}`
  - `chatWithVehicleData(apiKey, history, message, context, modelName?)` — multi-turn chat with vehicle data injected as system context
  - `validateApiKey(apiKey, modelName?)` — fires a test prompt to confirm the key works

**Vercel Analytics:**
- Purpose: Page-view and performance tracking
- SDK/Client: `@vercel/analytics` 1.6
- Integration point: `<Analytics />` component rendered at the bottom of `src/App.tsx` (outside all routing)
- Config: Zero-config; works automatically on Vercel deployments

## Data Storage

**Database — Supabase PostgreSQL:**
- Provider: Supabase (hosted)
- Project ID: `drqmrddxlrlbqnydumjm` (see `supabase/config.toml`)
- Connection env vars: `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`
- Client instantiation: `src/integrations/supabase/client.ts` — typed with generated `Database` type from `src/integrations/supabase/types.ts`
- Client options: `auth.storage = localStorage`, `persistSession: true`, `autoRefreshToken: true`
- ORM/Query layer: Supabase JS SDK (`supabase.from(...).select/insert/update/delete`)

**Database Schema (all tables with RLS enabled):**

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `car_profiles` | Vehicle profiles per user | `id`, `user_id`, `name`, `notes`, `is_admin`, `created_at` |
| `sessions` | OBD2 upload sessions | `id`, `car_profile_id`, `user_id`, `source_filename`, `source_file_path`, `source_csv`, `uploaded_at`, `duration_seconds`, `summary`, `gemini_analysis` |
| `session_rows` | Time-series data points | `id`, `session_id`, `t_seconds`, `t_timestamp`, `data` (JSONB) |
| `session_flags` | Diagnostic alerts | `id`, `session_id`, `severity`, `canonical_key`, `parameter_key`, `message`, `evidence` (JSONB), `resolved` |
| `parameter_rules` | Per-car threshold rules | `id`, `car_profile_id`, `canonical_key`, `parameter_key`, `label`, `unit`, `normal_min/max`, `warn_min/max`, `critical_min/max` |
| `chat_conversations` | AI chat sessions | `id`, `user_id`, `car_profile_id`, `title`, `created_at`, `updated_at` |
| `chat_messages` | Chat message parts | `id`, `conversation_id`, `role` (`user`/`assistant`), `parts` (JSONB), `attachments` (JSONB), `created_at` |
| `app_settings` | User/system key-value store | `id`, `setting_key`, `setting_value`, `user_id`, `encrypted`, `created_at`, `updated_at` |

**Row Level Security:**
- All tables enforce user-scoped RLS; policies use `auth.uid() = user_id`
- `chat_messages` RLS is indirect: checks `conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = auth.uid())`
- Triggers auto-set `user_id` on insert for `car_profiles` and `sessions` via `public.set_user_id()` function

**File Storage — Supabase Storage:**
- Bucket: `session-csv` (private, max 50 MB, MIME types: `text/csv`, `application/vnd.ms-excel`)
- Migration: `supabase/migrations/20260219105200_session_csv_storage.sql`
- Path pattern: `{userId}/{carProfileId}/{timestamp}-{uuid}-{filename}`
- RLS: folder-based; first path segment must equal `auth.uid()`
- Operations live in `src/lib/db.ts`: `uploadSessionCSV()`, `downloadSessionCSV()`
- Path stored in `sessions.source_file_path` column

**Caching:**
- TanStack React Query (`@tanstack/react-query` 5.83) — client-side server-state cache
- Single `QueryClient` instance created in `src/App.tsx`; no explicit stale-time configuration observed
- No external remote cache (Redis, etc.)

## Authentication & Identity

**Auth Provider: Supabase Auth**
- Implementation: `src/contexts/AuthContext.tsx` — React context wrapping the whole app
- Session storage: `localStorage` (configured in `src/integrations/supabase/client.ts`)
- Auto token refresh: enabled

**Supported auth methods:**
- Email + password: `supabase.auth.signInWithPassword()`, `signUp()`, `resetPasswordForEmail()`
- Google OAuth: `supabase.auth.signInWithOAuth({ provider: 'google' })`
  - Redirect URL: `VITE_APP_URL` env var (strips trailing slash); falls back to `window.location.origin`
  - Migration enabling Google OAuth: `supabase/migrations/20260219161400_google_oauth.sql`

**Auth context API** (`src/contexts/AuthContext.tsx`):
- `user: User | null` — current Supabase user
- `session: Session | null` — current session
- `loading: boolean` — true during initial session fetch
- `signIn(email, password)`, `signInWithGoogle()`, `signUp(email, password)`, `signOut()`, `resetPassword(email)`

**Protected routing:**
- `src/components/PrivateRoute.tsx` — redirects unauthenticated users; used via `AuthenticatedLayout` in `src/App.tsx`
- `CarsProvider` is only mounted inside authenticated routes

## Monitoring & Observability

**Error Tracking:**
- None configured (no Sentry, Datadog, etc.)
- Errors logged to browser console via `console.error()` throughout `src/`

**Logs:**
- Browser console (development and production browser-side)
- Supabase dashboard logs (server-side queries, auth events)
- Vercel platform logs (build and serverless function logs)

**Analytics:**
- Vercel Analytics — automatic page views; `<Analytics />` in `src/App.tsx`

## CI/CD & Deployment

**Hosting:**
- Vercel — SPA deployment
- `vercel.json` configures catch-all rewrite to `/index.html` for React Router

**CI Pipeline — GitHub Actions:**

1. **`supabase-keepalive.yml`** — runs every 6 hours via cron `0 */6 * * *`
   - Calls `npm run supabase:keepalive` → `scripts/supabase-keepalive.mjs`
   - Uses service role key to write/read `app_settings` and query `sessions`
   - After success: commits a heartbeat file to `main` with `[skip ci]` to prevent GitHub from disabling the workflow after 60 days of inactivity
   - Secrets required: `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

2. **`supabase-keepalive-healthcheck.yml`** — health check companion workflow

**Build:**
- Command: `vite build`
- Output: `dist/`
- Dev server: `vite` on `0.0.0.0:5000`

## Environment Configuration

**Required env vars:**

| Variable | Used by | Purpose |
|----------|---------|---------|
| `VITE_SUPABASE_URL` | Browser + keepalive scripts | Supabase project API URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser | Supabase anon/public key |
| `VITE_APP_URL` | Browser | Canonical app URL for Google OAuth redirect |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions scripts only | Admin Supabase operations (keepalive) |

**Secrets location:**
- Local: `.env` file (not committed)
- CI: GitHub Actions repository secrets
- User API keys: `app_settings` table in Supabase (per-user, `setting_key = 'gemini_api_key'`)

## Webhooks & Callbacks

**Incoming:**
- None explicitly configured

**Outgoing (OAuth callbacks):**
- Google OAuth redirect: `VITE_APP_URL` (or `window.location.origin`) — Supabase handles the OAuth exchange and sets the session
- Password reset redirect: `{window.location.origin}/reset-password`

## Data Flow

**OBD2 Session Analysis Flow:**
1. User uploads CSV → `src/lib/db.ts:uploadSessionCSV()` stores file in Supabase Storage (`session-csv` bucket)
2. Session record created in `sessions` table; CSV parsed into `session_rows` (batched inserts of 200)
3. Diagnostic flags computed and inserted into `session_flags`
4. Aggregated summary sent to Gemini: `src/lib/gemini-service.ts:analyzeSession()`
5. Gemini returns `{summary, insights, recommendations}`; stored in `sessions.gemini_analysis`
6. Displayed in `src/pages/SessionDetail.tsx`

**AI Chat Flow:**
1. User opens chat in `src/components/chat/ChatContainer.tsx`
2. Conversation created in `chat_conversations` via `src/lib/chat/db.ts:createConversation()`
3. Vehicle context assembled from `car_profiles` + recent `sessions`: `buildChatContext(carProfileId)`
4. User message saved to `chat_messages` (parts format: `[{type:'text', text:'...'}]`)
5. Full message history + context sent to Gemini: `chatWithVehicleData()`
6. AI response saved to `chat_messages` with `role: 'assistant'`
7. Messages rendered in `src/components/chat/MessageList.tsx` using `react-markdown`

---

*Integration audit: 2026-05-17*
