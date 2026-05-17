# Gaps Fix Plan

**Date:** 2026-05-17
**Status:** Plan only — execution pending approval
**Constraint:** Supabase Free, Vercel Hobby, GitHub Free — every decision must respect these limits.

## Free-tier reality check

| Resource | Free limit | Current load | Headroom |
|----------|-----------|--------------|----------|
| Supabase DB | 500 MB | ~5 MB after onboarding work | Plenty |
| Supabase Storage (session-csv + session-photos) | 1 GB total | Empty | Photos at 10 MB each ⇒ max ~100 photos system-wide if everyone uses max size |
| Supabase Edge Function invocations | 500 K / month | 0 | A chat-heavy user could send 30 msgs/day = 900/mo. Even 100 users = 90 K. Safe but worth monitoring |
| Supabase bandwidth | 5 GB / month egress | Negligible | OK |
| Supabase project pause | 7-day inactivity | Mitigated by Phase 01 keepalive | OK |
| Vercel bandwidth | 100 GB / month | Negligible | OK |
| Vercel serverless timeout | 10 s | Not used (PWA / SPA only) | OK |
| GitHub Actions | 2000 min / month private | Keepalive ~30 min/mo | OK |

**Key implication:** Edge Functions are the resource to watch. Every `chat` and `analyze-session` call counts. Rate-limit by user. Fallback to client-side path if quota nears exhaustion.

---

## The 7 gaps

### Gap 1 — Gemini secret has no super-admin UI to configure it

**State:** Migration `20260517190000_admin_secrets.sql` applied. `is_admin_user()` RPC, RLS policies for system-wide `app_settings` rows, two seed rows (`admin_secret_gemini_api_key`, `admin_gemini_model`) live. `listAdminSettings`, `upsertAdminSetting`, `isAdminUser` functions written in `src/lib/db-extras.ts`. **UI page not created. Nav entry missing. Edge Functions don't read from DB yet.**

**Fix:**
- `src/pages/AdminPage.tsx` — new page. Renders only when `isAdminUser()` resolves true; redirects non-admins to `/`. Lists `KNOWN_ADMIN_SETTINGS` with masked input for secrets, plain input for regular settings. Save button calls `upsertAdminSetting`.
- `src/App.tsx` — add `/admin` route inside `AuthenticatedLayout`.
- `src/components/AppLayout.tsx` — conditional admin nav link (visible only when `isAdminUser()` cached true). Add a small `useAdminStatus()` hook to fetch once and cache in a context to avoid hitting RPC on every render.
- Edge Functions `analyze-session` and `chat` — instead of reading `Deno.env.get("GEMINI_API_KEY")`, query `app_settings` via the service role client with `setting_key='admin_secret_gemini_api_key'`. Fall back to env if DB value is null (so the old path still works).

**Effort:** S (45 min).

**Free-tier impact:** Each Edge Function call now does 1 extra DB read. Mitigate with 60-second in-memory cache inside the function. Net cost: negligible.

---

### Gap 2 — `ai-client.ts` exists but nothing imports it

**State:** Wrapper for both Edge Functions written. `use-csv-upload.ts` (auto AI on upload) and `ChatContainer.tsx` (user chat) still import directly from `gemini-service.ts` which uses the **client-side** API key from `app_settings`.

**Fix:**
- `src/hooks/use-csv-upload.ts` — replace the dynamic import of `analyzeSession` with `analyzeSessionViaEdge` from `ai-client.ts`. Falls back to `analyzeSession` if Edge returns null (preserves old per-user-key path during rollout).
- `src/components/chat/ChatContainer.tsx` — replace the chat sending logic to call `chatViaEdge` first, fall back to direct Gemini if it fails.
- Keep `gemini-service.ts` as fallback for users who have their own key configured. Eventually deprecate once the admin secret is set.

**Effort:** S (30 min).

**Free-tier impact:** Shifts inference cost from user-pays (their Gemini key) to server-pays (admin's Gemini key via the Edge Function). The admin's Gemini key on Google's free tier gets 15 requests/minute, 1500/day. **Add a rate limiter** per `auth.uid()` in the Edge Function: max 30 chat msgs/day on free; bump on paid tier later. Use a small `user_quotas` table or a simple in-memory bucket per Edge Function instance.

---

### Gap 3 — `ChatContext` is dumped as raw JSON in the system prompt

**State:** `buildChatContext` now returns `trends`, `activeDtcs`, `maintenance`. But Edge Function `chat`/`index.ts` does `JSON.stringify(context, null, 2)` and sends that whole blob to Gemini. Works, but burns tokens and produces vaguer answers.

**Fix:**
- `supabase/functions/chat/index.ts` — replace `buildSystemPrompt` with a structured template that bullets the most actionable facts:
  ```
  VEHICLE: 2010 Toyota Prius (VIN: ABC...). Hybrid. 230k km.

  RECENT FLAGS (unresolved): 2
    - CRITICAL: coolant_temp peaked at 118°C for 45s on 2026-05-12
    - ATTENTION: stft_b1 drifted to +12% on 2026-05-10

  ACTIVE DTCs (3): P0420, P0301, P0AA6

  TRENDS (last 5 vs prior 20 sessions):
    - fuel_economy declining 8.4% (current 38 mpg vs historic 41 mpg)
    - coolant_temp_avg climbing 6% (now averaging 99°C vs 93°C)

  MAINTENANCE (last 12 months):
    - oil_change at 230,500 km (2026-02-10)
    - tire_rotation at 232,000 km (2026-04-01)
  ```
- Skip empty sections. Cap each section to top 5 items.
- Token reduction ~30% based on rough count.

**Effort:** S (20 min).

**Free-tier impact:** Reduces Gemini token usage per chat call by ~30%. Stays well inside Gemini's free 15 RPM. Quality goes up.

---

### Gap 4 — i18n is set up but nothing renders translations

**State:** `react-i18next` installed, `lib/i18n.ts` initialized, three locale files (en / pt-BR / es-ES) with ~50 strings. **No component imports `useTranslation()`.** UI is fully hardcoded English.

**Fix (pragmatic scope):**
- Wire `useTranslation()` in 8 high-traffic surfaces only:
  1. `OnboardingWizard.tsx` (4 steps × ~5 strings)
  2. `CarsPage.tsx`
  3. `Index.tsx` (KPIs labels)
  4. `FlagsPanel.tsx` (severity labels + "What should I do?" expander)
  5. `DTCPanel.tsx`
  6. `MaintenancePage.tsx`
  7. `AppLayout.tsx` (nav labels)
  8. `SettingsPage.tsx`
- Add a language switcher in Settings (3 buttons: EN / PT-BR / ES-ES).
- Browser language autodetected by `i18next-browser-languagedetector` — first-time user sees PT-BR if their browser is Portuguese.

**Effort:** M (60 min).

**Free-tier impact:** Zero — pure client-side, 53 KB extra in `i18n` chunk (already isolated).

---

### Gap 5 — Mobile dashboard not fully reordered for mobile-first

**State:** `ActiveFlagsBanner` was added above-the-fold. Rest of `Index.tsx` (575 lines, desktop grid layout) unchanged.

**Fix:**
- Refactor `Index.tsx` into 5 vertical sections, ordered for mobile:
  1. **ActiveFlagsBanner** (sticky on mobile, normal on desktop) — already in place
  2. **HealthGauge + 4 KPIs** (already-extracted `HealthGauge` component; use it!)
  3. **Latest Trip** card
  4. **Trends** chart (collapsed by default on mobile, expanded on desktop)
  5. **Per-parameter charts** (last; lazy-loaded)
- Extract `<StatCard>` (small icon + number) and `<DashboardSection>` (heading + collapse-on-mobile) so future polish is cheaper.
- Touch targets: ensure all interactive elements are ≥44×44 px.

**Effort:** M (45 min). Doesn't change features, just rearranges + extracts components.

**Free-tier impact:** Nil. Slightly smaller bundle if extraction is clean.

---

### Gap 6 — End-to-end not tested in a browser

**State:** Build passes, TypeScript happy. But `npm run dev` was never launched.

**Fix (smoke test checklist):**
1. `npm run dev` → http://localhost:5000
2. Walk through (with a fresh user OR `localStorage.clear()`):
   - Signup → should redirect to `/onboarding`
   - Onboarding Step 2: enter a VIN, click ✨ → fields auto-fill (network call to NHTSA)
   - Onboarding Step 3: upload a sample CSV (or skip)
   - Onboarding Step 4 → land on dashboard
   - Dashboard → ActiveFlagsBanner if there are active flags
   - Navigate to `/cars` → edit/delete buttons visible on hover
   - Navigate to `/maintenance` → add a service event
   - Navigate to `/session/:id` → DTCPanel renders if active_dtcs has codes, PhotoUpload renders, Share with mechanic copies a `/share/UUID` link
   - Open that link in incognito → public report renders without login
3. Build PWA: `npm run build && npm run preview` → check that the service worker registers and the app installable.
4. Test offline: in DevTools Application tab, throttle to offline → app shell + last-loaded sessions remain visible.

**Effort:** S (20 min).

**Likely findings:** Some minor visual glitches; the realtime subscription channel name might collide if user switches cars; AppLayout `useAdminStatus()` may flash before resolving (need skeleton).

---

### Gap 7 — Photo / Edge Function quotas not enforced

**State:** Photo upload has no per-user limit. Edge Functions have no rate limit. On free tier this is fine for testing but will burn out fast in real use.

**Fix:**
- Migration: `user_quotas` table tracking `chat_messages_today`, `analysis_today`, `photos_uploaded`. RLS: users see only their row.
- Edge Function `chat` checks `chat_messages_today` against a constant (free: 30/day). Returns 429 if exceeded.
- Edge Function `analyze-session` checks `analysis_today` (free: 10/day, more than enough).
- Photo upload (client-side): query session count + photo count for user; cap at 5 photos per session, 100 photos per user.
- Daily reset via a Postgres `pg_cron`-style scheduled function, or computed on-the-fly using `WHERE created_at::date = current_date`.

**Effort:** M (45 min).

**Free-tier impact:** This *enables* staying on free tier indefinitely. Without quotas, a curious user could exhaust Gemini's 1500 req/day in one afternoon.

---

## Execution order

Each numbered step is independently shippable. After every step: `npx tsc --noEmit && npx eslint src && npm run build`, then commit.

| # | Step | Effort | Why this order |
|---|------|--------|----------------|
| 1 | **Gap 1** — Admin page + Edge Function reads DB secret | 45 min | Unblocks D1 — without this the deployed Edge Functions are dead weight |
| 2 | **Gap 2** — Wire `ai-client.ts` into upload + chat | 30 min | Makes the Edge Functions actually be called |
| 3 | **Gap 7** — Quotas in Edge Functions | 45 min | Must land BEFORE the world finds the deployed functions |
| 4 | **Gap 3** — Better AI system prompt | 20 min | Quality bump, pure server-side change |
| 5 | **Gap 5** — Mobile dashboard reorder + StatCard / HealthGauge extraction | 45 min | Visible UX improvement |
| 6 | **Gap 4** — i18n in 8 components + language switcher | 60 min | Larger but contained |
| 7 | **Gap 6** — Browser smoke test + fix anything that breaks | 30–60 min | Last; fixes whatever the previous steps missed |

**Total:** ~4 to 5 hours condensed.

## Risk register

| Risk | Mitigation |
|------|------------|
| Gemini admin key set in DB might leak via `SELECT *` | RLS only allows admin to read, and the column is masked in the UI. Service role bypass is the only read path the Edge Functions use. |
| Realtime subscription leaves dangling channels on car switch | Use `useEffect` cleanup as already implemented. Smoke test in Gap 6 validates this. |
| PWA aggressively caches a broken JS bundle | `autoUpdate` registration + `skipWaiting`. If a deployment breaks, hard-refresh fixes it. Document in README. |
| Edge Function 1500 req/day Gemini quota exhausted on launch day | Quotas (Gap 7) cap chat at 30 msg/user/day. If 50 users hit max same day = 1500 — at the limit. Acceptable; bump quotas down if it pinches. |
| i18n adds runtime cost | Already isolated in its own chunk; `useTranslation()` is cheap. |

## Success criteria

- [ ] Admin (you) can log in, navigate to `/admin`, paste Gemini key, save.
- [ ] A new user (no key configured) signs in, opens chat, sends a message, gets a Gemini response — proves Edge Functions wired end-to-end.
- [ ] Spamming the chat 50 times triggers a 429 with a "daily limit reached" message.
- [ ] Switching browser language to Portuguese reloads the app in PT-BR.
- [ ] Mobile viewport (375×667 in DevTools) shows the active-flags banner at the top without horizontal scroll; all tap targets fit a finger.
- [ ] PWA installable, works offline for previously-viewed sessions.
- [ ] `npx tsc --noEmit`, `npx eslint`, `npm run build` all green.

---

*Plan only. Execution pending approval.*
