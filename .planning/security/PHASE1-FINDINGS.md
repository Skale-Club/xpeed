# Xpeed Security Review — Phase 1 Findings

**Date:** 2026-05-29
**Branch:** `security/xpeed-review`
**Method:** 6 parallel auditor agents, code-review evidence (file:line). Single-tenant-per-user (`user_id`) app: React+Vite SPA + Supabase + Deno Edge Functions.
**Notion:** Security Review — Xpeed → Evidence / Verification (full report + roadmap items S01–S13).

## Verdict matrix

| Area | Verdict | Top severity |
|------|---------|--------------|
| S01 Injection | PASS | Low (dev script) |
| S02 XSS | PASS | — |
| S03 CSRF | PASS | — |
| S04 Input validation | FINDING | Medium |
| S05 Security headers | FINDING | Medium |
| S06 Secrets | FINDING | High |
| S07 Auth/AuthZ | **FINDING** | 🔴 Critical |
| S08 File uploads | FINDING | Medium |
| S09 Errors/logs/detection | FINDING | Medium |
| S10 Dependencies | FINDING (mostly remediated) | Low |
| S11 Rate limiting | FINDING | Medium |
| S12 Webhook authenticity | PASS | — |
| S13 Tenant isolation | **FINDING** | 🔴 Critical |

## 🔴 Critical

### S07-1 — Privilege escalation to admin via car_profiles INSERT
Any authenticated user can `INSERT` a `car_profiles` row with `is_admin: true`. The `car_profiles_lock_is_admin` trigger only fires `BEFORE UPDATE` (`supabase/migrations/20260527000001_lock_is_admin.sql:14-18`); INSERT RLS `WITH CHECK` never inspects `is_admin`. Grants admin SELECT over all users' sessions + write to global `app_settings`.
**Fix:** `BEFORE INSERT` trigger forcing `NEW.is_admin := false`; promotion only via service-role/SQL. Remove client-side `is_admin:true` upserts in `SetupAdminPage.tsx`.

### S13-1 — Cross-user data leak in analyze-session
`supabase/functions/analyze-session/index.ts:147-159` reads any `sessions` row by client-supplied `sessionId` with the service-role client and **no `user_id` filter**; the returned AI summary describes the victim's VIN/DTCs/parameters.
**Fix:** add `.eq("user_id", userId)`; return 404 on miss.

## 🟠 High
- **S13-2** — `supabase/functions/mcp-server/services/sessions.ts:78` filters `session_flags`/`session_rows` on a non-existent `user_id` column; isolation holds only by query error. Verify parent-session ownership (mirror `car-insights-mcp`).
- **S06-1** — `VITE_ADMIN_PASSWORD`/`VITE_ADMIN_EMAIL` baked into bundle + rendered in DOM (`src/pages/SetupAdminPage.tsx:10-11,273,324`). Rotate if ever set; delete page.
- **S06-2** — Gemini API key plaintext in `app_settings` (`src/lib/db-extras.ts:276`). Current RLS hides `admin_secret_%` from client SELECT (verified), but S07-1 makes it exfiltratable. Move to Edge Function env / pgsodium.

## 🟡 Medium
- **S05-1** — No HTTP security headers (`vercel.json` has no `headers` block). Compensating control for JWT-in-localStorage.
- **S04-1/-2** — Edge Functions accept request JSON with no schema validation (`chat/index.ts:169`, `analyze-session/index.ts:141`); CSV upload no size/row cap (`use-csv-upload.ts:40`).
- **S08-1** — Private `session-photos` bucket served via `getPublicUrl()` (`src/lib/db-extras.ts:118`). Use `createSignedUrl`, keep private.
- **S09-1/-2/-3** — No React error boundaries (`src/App.tsx:51`); Edge Functions leak internal/DB errors to clients (`xpeed-oauth/index.ts:112,176,213` worst); no audit table / alerting.
- **S11-1** — Quota check is non-atomic count-then-insert TOCTOU race + fails open (`_shared/quota.ts:39-64`); amplified by auto-analysis on every upload.

## 🟢 Low / governance
- S07-3 `/setup-admin` public route leaks admin email + ops SQL.
- S07-misc MCP token accepted via `?key=` query param (log exposure).
- S08 SVG allowed in public `app-icons`/`brand-assets` buckets.
- S09-4 quota fail-open unlogged.
- S10-1 caret pinning + `package.json`↔lock drift + no SCA CI gate.
- S04-3 loose OAuth `redirect_uri` regex (`xpeed-oauth/index.ts:93`).
- S11-2 no rate limit on `/register` (unbounded `oauth_clients` spam) or `/token`.
- S01 dev migration scripts use `split(';')` + anon `exec_sql` (dead post-hardening) — delete.

## What PASSED
Injection (parameterized PostgREST/RPC, `exec_sql` locked to service-role), XSS (safe `react-markdown` defaults, router CVE not exploitable — no data-router/SSR), CSRF (Bearer-in-header, not cookies), and webhook authenticity. The OAuth 2.1 server and the `xpeed-mcp`/`car-insights-mcp` per-tool `user_id` scoping are exemplary. RLS deliberately hardened in `20260528100000` (all legacy `USING(true)` removed).

## Phase 0 — Baseline (recap)
- **B01** dependency scan: 20 → 2 vulns after `npm audit fix` (commit `fe41554`). Remaining 2 moderate are **dev/build-only** (esbuild/vite dev-server, need vite@8 major — deferred). Production `react-router` patched (6.30.3).
- **B02** secret scan: CLEAN (env gitignored, nothing in history).
- **B03** advisors: 23/23 tables have RLS in migrations. ⚠️ Live Supabase advisor not run (connected MCP points to other projects, not xpeed `drqmrddxlrlbqnydumjm`) — needs dashboard/CLI access.
- **B04** license hygiene: 59 + 22 deps; full enumeration deferred to S10.

## Suggested remediation order (Phase 2 — needs human approval)
1. **S07-1** (DB trigger) + **S13-1** (one-line `user_id` filter) — Critical, small fixes.
2. **S13-2**, **S06-1/-2** — High.
3. **S05** headers, **S11-1** atomic quota, **S08-1** signed URLs, **S09** error boundary + sanitized errors + audit log.
4. **S04** zod schemas, **S10** CI SCA gate, remaining Low items.
