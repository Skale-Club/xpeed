# External Integrations

**Analysis Date:** 2026-05-29

## APIs & External Services

**AI / Machine Learning:**
- Google Gemini API - Powers session analysis and vehicle chat assistant
  - SDK: `@google/generative-ai` (Edge Function side), `@ai-sdk/react` + `ai` (client side)
  - Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  - Auth: API key resolved from DB (`app_settings.admin_secret_gemini_api_key`) with env fallback `GEMINI_API_KEY`
  - Used in: `supabase/functions/analyze-session/index.ts`, `supabase/functions/chat/index.ts`
  - Default model: `gemini-2.5-flash` (DB-configurable, key `admin_gemini_model`)
  - Quota: 10 analyses/user/day, 30 chat messages/user/day (enforced in `supabase/functions/_shared/quota.ts`)

**Vehicle Data:**
- NHTSA vPIC API - Free VIN decoding, no API key required
  - Endpoint: `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/{VIN}?format=json`
  - Client: `src/lib/vin-decoder.ts`
  - Timeout: 5 seconds (`AbortSignal.timeout(5000)`)
  - Cached by PWA service worker (CacheFirst, 30-day expiry, 200 entry limit)

## Data Storage

**Databases:**
- Supabase PostgreSQL (project `drqmrddxlrlbqnydumjm`)
  - Connection: `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (frontend anon key)
  - Service role: `SUPABASE_SERVICE_ROLE_KEY` (Edge Functions and scripts only)
  - Client: `@supabase/supabase-js` 2.95, singleton at `src/integrations/supabase/client.ts`
  - Key tables: `car_profiles`, `sessions`, `session_flags`, `maintenance_events`, `parameter_baselines`, `app_settings`, `mcp_tokens`, `oauth_clients`, `oauth_authorization_codes`, `oauth_refresh_tokens`, `user_quotas`, `vehicle_issues`, `shared_reports`, `rule_library`
  - Migrations: `supabase/migrations/` (30+ migration files)

**File Storage:**
- Supabase Storage
  - Bucket `session-csv` - Stores uploaded OBD2 CSV files
  - Bucket `app-icons` - Admin-uploaded PWA icons (192px, 512px, apple-touch-icon)
  - Bucket `brand-assets` (migration `20260527000008_brand_assets_bucket.sql`) - Branding images
  - Referenced in: `src/lib/db.ts` (`SESSION_CSV_BUCKET`), `vite.config.ts` (icon URLs)

**Caching:**
- PWA service worker (Workbox) - Offline-first caching for Supabase REST reads and NHTSA VIN API
- Edge Function in-memory cache - 60-second TTL for `app_settings` reads in `supabase/functions/_shared/admin-config.ts`

## Authentication & Identity

**Auth Provider:**
- Supabase Auth - Primary authentication system
  - Implementation: `src/contexts/AuthContext.tsx`
  - Methods supported: email/password, Google OAuth
  - Session storage: `localStorage` (configured in `src/integrations/supabase/client.ts`)
  - Google OAuth redirect: `VITE_APP_URL` env var (must be registered as OAuth redirect URI in Supabase dashboard)

**MCP / AI Agent Auth (OAuth 2.1 Server):**
- Custom OAuth 2.1 server implemented as Supabase Edge Functions + Vercel Edge proxies
  - Authorization endpoint: `/oauth/authorize` (SPA page `src/pages/OAuthAuthorize.tsx`)
  - Token endpoint: `/api/oauth/token` (proxy `api/oauth/token.ts` → `supabase/functions/xpeed-oauth/token`)
  - Registration endpoint: `/api/oauth/register` (proxy `api/oauth/register.ts` → `supabase/functions/xpeed-oauth/register`)
  - Grant types: `authorization_code` (PKCE S256 required), `refresh_token` (rotated)
  - Access tokens: HS256 JWTs, 1-hour TTL, signed with `XPEED_OAUTH_JWT_SECRET`
  - Refresh tokens: opaque 48-byte random strings, SHA-256 hashed at rest, 30-day TTL
  - Discovery docs: `/.well-known/oauth-authorization-server` (`api/wellknown/oauth-authorization-server.ts`), `/.well-known/oauth-protected-resource` (`api/wellknown/oauth-protected-resource.ts`)

**API Key Tokens:**
- Opaque per-user tokens stored SHA-256 hashed in `mcp_tokens` table
  - Management UI: `src/components/McpTokensSection.tsx`
  - Client lib: `src/lib/mcp-tokens.ts`
  - Edge Function manager: `supabase/functions/manage-mcp-tokens/index.ts`
  - Accepted via `X-API-Key` header or `?key=` query param on the MCP server

## Monitoring & Observability

**Analytics:**
- Vercel Analytics - Page view tracking
  - Package: `@vercel/analytics` 1.6
  - Injected in: `src/App.tsx` (`<Analytics />` component)

**Error Tracking:**
- None detected (no Sentry, DataDog, or similar)

**Logs:**
- `console.log` / `console.error` / `console.warn` throughout Edge Functions
- Supabase Edge Function logs accessible via Supabase dashboard

## CI/CD & Deployment

**Hosting:**
- Vercel - Production SPA + Edge Functions (`api/` directory)
  - Production URL: `https://xpeed-skaleclub.vercel.app`
  - Edge Functions runtime: Vercel Edge Runtime (TypeScript, `export const config = { runtime: 'edge' }`)

**CI Pipeline:**
- GitHub Actions
  - `supabase-keepalive.yml` - Runs every 6 hours, writes heartbeat to `app_settings`, commits `keepalive-heartbeat` file to prevent repo deactivation
  - `supabase-keepalive-healthcheck.yml` - Health check variant
  - Uses secrets: `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

**Supabase Edge Functions:**
- `supabase/functions/analyze-session/` - AI session analysis
- `supabase/functions/chat/` - AI chat with vehicle context
- `supabase/functions/xpeed-mcp/` - MCP server (JSON-RPC 2.0)
- `supabase/functions/xpeed-oauth/` - OAuth 2.1 authorization server
- `supabase/functions/manage-mcp-tokens/` - MCP token CRUD
- `supabase/functions/car-insights-mcp/` - Additional MCP tools (car insights)
- `supabase/functions/mcp-server/` - Modular MCP server with service/tool split

## MCP (Model Context Protocol) Server

- Exposes Xpeed data to AI agents (Claude.ai Custom Connectors, etc.)
  - Protocol: JSON-RPC 2.0 over HTTP, MCP protocol version `2024-11-05`
  - Endpoint: `/api/mcp` (Vercel proxy) → `supabase/functions/xpeed-mcp`
  - Tools: `list_vehicles`, `list_sessions`, `get_session_detail`, `get_vehicle_health`, `list_maintenance`, `list_flags`
  - Auth: accepts Xpeed OAuth JWT, Supabase JWT, or opaque API key token

## Environment Configuration

**Required env vars:**
- `VITE_SUPABASE_URL` - Supabase project URL (e.g. `https://drqmrddxlrlbqnydumjm.supabase.co`)
- `VITE_SUPABASE_PUBLISHABLE_KEY` - Supabase anon/publishable key
- `VITE_APP_URL` - Production app URL for OAuth redirects (e.g. `https://xpeed-skaleclub.vercel.app`)
- `SUPABASE_SERVICE_ROLE_KEY` - Server-side service role key (scripts and CI only)

**Optional env vars:**
- `XPEED_OAUTH_JWT_SECRET` - Required for OAuth 2.1 server to sign JWTs (set as Supabase Edge Function secret)
- `GEMINI_API_KEY` - Fallback if not stored in DB
- `GEMINI_MODEL` - Fallback model name if not stored in DB
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` - For setup/admin scripts only
- `VITE_ADMIN_EMAIL` / `VITE_ADMIN_PASSWORD` - Client-side admin access (dev only)

**Secrets location:**
- Supabase Edge Function secrets (set via Supabase CLI or dashboard): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `XPEED_OAUTH_JWT_SECRET`, `XPEED_APP_URL`
- GitHub Actions secrets: `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Vercel environment variables: all `VITE_*` vars plus `SUPABASE_SERVICE_ROLE_KEY`
- DB-stored secrets (admin-configurable): Gemini API key, Gemini model name (in `app_settings` table, accessed via `supabase/functions/_shared/admin-config.ts`)

## Webhooks & Callbacks

**Incoming:**
- `/import` - PWA Web Share Target receives CSV files via POST (multipart/form-data), handled by `src/pages/ShareImportPage.tsx`
- `/oauth/authorize` - OAuth 2.1 authorization page (user consent UI), `src/pages/OAuthAuthorize.tsx`

**Outgoing:**
- Gemini API REST calls from Edge Functions (no webhook, request/response pattern)
- NHTSA VIN API REST calls from browser (`src/lib/vin-decoder.ts`)

---

*Integration audit: 2026-05-29*
