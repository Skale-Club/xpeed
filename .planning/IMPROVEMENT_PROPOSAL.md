# Improvement Proposal — car-insights-ai

**Date:** 2026-05-17
**Author:** Deep system analysis
**Scope:** Recommendations to make the product deliver on its core promise — turning raw OBD2 data into actionable car diagnostics that a normal human can act on.

## Executive summary

The product works mechanically but underdelivers on its value proposition. Today it:

1. **Accepts CSV uploads** and stores them.
2. **Detects threshold violations** using a hardcoded Prius rule set.
3. **Shows technical numbers** in a desktop dashboard.
4. **Optionally enriches with Gemini** if the user configured an API key.

The gap between this and a great product is not features — it's *coherence*. A 2010 Prius owner uploading a CSV today gets useful insight; a 2019 Subaru WRX owner gets the dashboard but flags that are calibrated for a different engine. A new user lands in a wizard that asks for the right fields, registers the car, but the rule engine then ignores the make/model entirely. A user in a garage looking up "why is my coolant high" can't open the chat because the floating bubble doesn't show until the dashboard fully loads.

The fix is not a rewrite. It's a focused 6–10 week roadmap that closes the loop between **vehicle identity → calibrated rules → human-readable insights → actionable next steps**.

This document proposes **18 improvements** grouped into **5 themes**, each with priority, effort, and impact.

---

## Themes

| # | Theme | Why it matters |
|---|-------|----------------|
| A | Vehicle-aware diagnostics | Today every car gets Prius thresholds. This is the single biggest credibility gap. |
| B | Actionability layer | "Coolant > 105°C" is not actionable. "Stop driving and let it cool, then check coolant level" is. |
| C | Mobile-first & garage workflow | Real diagnostics happen near the car, on a phone, with one hand free. The current UI is desktop-shaped. |
| D | Intelligence layer | The Gemini integration is opt-in, key-managed by the user, and used once at upload time. It could be the *core* UX, not a feature. |
| E | Data quality & scale | Silent 1000-row truncation, naive health score, no baseline/trend per car. Trust is built on data quality. |

---

## Improvements

### Theme A — Vehicle-aware diagnostics

#### A1. Make/Model rule library (P0, L, Impact 5)

**Problem:** `src/lib/default-rules.ts` exports `DEFAULT_PRIUS_RULES` only. Every car uses these thresholds regardless of make/model. A Subaru WRX redlines at 6800 rpm — the current rule flags it "critical" at 5200 rpm.

**Proposal:** Build a rule library keyed by `make/model/year_range/engine_type`.

- Schema: extend `parameter_rules` table to support inheritance (`base_ruleset_id`, `applies_to_makes JSONB`).
- Seed 8–10 popular make/model rulesets: Prius (existing), Civic, Camry, F-150, Mustang, WRX, Tesla Model 3, common diesels.
- On session upload, resolve the right ruleset using `car_profile.make + model + year`.
- Fall back to a generic "petrol" or "hybrid" or "diesel" baseline if no specific match.
- Allow users to override thresholds per parameter (already partly supported by the table, no UI).

**Files:** `src/lib/rule-resolver.ts` (new), `supabase/migrations/{date}_rule_library.sql`, `src/lib/default-rules/` (folder with one file per ruleset), `src/pages/SettingsPage.tsx` (per-car overrides UI).

#### A2. DTC code support (P0, M, Impact 5)

**Problem:** The most useful data from OBD2 — Diagnostic Trouble Codes (P0420, P0301, etc.) — is **completely unhandled**. CSVs from Torque Pro and OBD Fusion contain DTC columns; we ignore them.

**Proposal:**
- Parse DTC columns during CSV ingestion (typical headers: `Trouble Codes`, `DTC`, `P-Code`).
- Maintain a static `dtc-codes.ts` lookup (1500+ standardized codes, ~80KB) with name + description + severity + likely cause + repair difficulty.
- Surface DTCs as a distinct section in the session detail view, *separately from rule-based flags*.
- Gemini prompt enrichment: pass active DTCs as context for the chat and analysis.

**Files:** `src/lib/dtc-codes.ts` (new), `src/lib/csv-parser.ts` (DTC extraction), `src/components/DTCPanel.tsx` (new).

#### A3. Auto-detect vehicle from VIN (P2, M, Impact 3)

**Problem:** Onboarding asks the user to type year/make/model. Fine for a known car, friction for someone who just bought a used vehicle. The VIN encodes all of this.

**Proposal:** When the user enters a VIN, hit NHTSA's free vDecoder API (`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/{vin}?format=json`) — no key needed, returns make/model/year/engine/transmission. Pre-fill the form, mark fields readonly with a "use detected" toggle.

**Files:** `src/lib/vin-decoder.ts` (new), `src/components/OnboardingWizard.tsx` (auto-decode hook).

### Theme B — Actionability layer

#### B1. Action-oriented flag messages (P0, S, Impact 5)

**Problem:** Flag messages today end at "Coolant temperature reached a critical zone." That's a diagnosis; users need a *prescription*.

**Proposal:** Restructure `Rule.notes` into three fields:
- `what_happened`: "Coolant temp hit 118°C for 45s."
- `why_it_matters`: "Sustained over-temp can damage the head gasket and degrade coolant."
- `what_to_do`: "Stop driving once safe. Let it cool. Check coolant level. If it repeats, get the cooling system pressure-tested."

Render as a collapsible "what should I do?" block in `FlagsPanel.tsx`. This is the difference between a *log viewer* and a *diagnostic tool*.

**Files:** `src/lib/default-rules.ts` (schema migration), `src/components/FlagsPanel.tsx`.

#### B2. Maintenance log & reminders (P1, M, Impact 4)

**Problem:** Cars need scheduled maintenance. The app sees every drive but doesn't track service history. A coolant flag is more meaningful if the last coolant flush was 4 years ago.

**Proposal:**
- New `maintenance_events` table: `{car_profile_id, type, performed_at, odometer, notes}`. Types: oil change, coolant flush, brake pads, transmission, battery, tire rotation, etc.
- `/maintenance` page: timeline view, add event, see "due in" estimates based on time/distance intervals.
- Surface maintenance context in flags: "Your last coolant flush was 4 years ago. Coolant degradation is consistent with this temperature pattern."
- Surface in chat context: passed to Gemini.

**Files:** `supabase/migrations/{date}_maintenance.sql`, `src/pages/MaintenancePage.tsx`, `src/lib/db.ts`.

#### B3. Printable diagnostic report (P1, M, Impact 4)

**Problem:** Users will want to share a session with a mechanic. There's no export.

**Proposal:** "Share with mechanic" button on session detail that generates a one-page PDF:
- Vehicle ID
- Date/duration/distance
- All flags with action items
- All active DTCs with descriptions
- Top 5 charts (coolant, RPM, fuel trims, battery, intake)
- AI summary
- Public read-only link (UUID, no auth) so the mechanic can open it on their phone.

**Files:** `src/lib/report-generator.ts` (use `@react-pdf/renderer` or HTML→PDF via Puppeteer in Edge Function), `src/pages/SharedReport.tsx` (public route), migration for `shared_reports` table.

### Theme C — Mobile-first & garage workflow

#### C1. PWA + offline-capable read (P0, M, Impact 4)

**Problem:** Garages have weak signal. The current SPA is online-only.

**Proposal:**
- Add Vite PWA plugin (`vite-plugin-pwa`).
- Service worker caches: app shell, last 30 days of sessions, all DTC lookups, rule library.
- "View offline" indicator. Uploads queue locally and sync when online.
- Add to home screen — looks like a native app.

**Effort:** ~2 days. Huge UX improvement.

**Files:** `vite.config.ts`, `public/manifest.webmanifest`, `src/lib/offline-cache.ts`.

#### C2. Mobile dashboard redesign (P1, M, Impact 4)

**Problem:** The current dashboard (`Index.tsx`, 575 lines) is designed for a desktop grid. On a phone everything stacks vertically and the user scrolls past the most important thing (active flags) to get to noisy charts.

**Proposal:** Re-order content for mobile:
1. Active critical flags (above the fold, sticky)
2. Health gauge (visual, 1 number)
3. Latest trip summary (1 card)
4. Trends (collapsed by default, tap to expand)
5. Per-parameter charts (last)

Use a single Recharts `ResponsiveContainer` with one focused chart instead of 6. Touch-optimized tap targets (44×44 minimum).

**Files:** Refactor `src/pages/Index.tsx` into smaller components (`<MobileDashboard>`, `<DesktopDashboard>` selectors based on viewport), extract `<HealthGauge>`, `<ActiveFlagsBanner>`.

#### C3. Image upload for dash/scanner photos (P1, M, Impact 5)

**Problem:** People in garages photograph their dashboard warning lights and scanner screens. The app has no way to consume this.

**Proposal:**
- Upload widget on session detail and in chat: "Add a photo (dashboard / scanner / engine bay)."
- Photos stored in Supabase Storage under `session-photos/{user_id}/{session_id}/`.
- Gemini supports vision in 2.5 Flash — pass photos as inline image parts in the chat. Massive insight uplift: "I see your check engine light is on with TC and ABS lights — based on your coolant pattern this is likely a thermostat failure causing limp mode."

**Files:** `src/components/PhotoUpload.tsx` (new), `src/lib/gemini-service.ts` (vision support), `supabase/migrations/{date}_session_photos.sql`.

#### C4. Prominent chat entry, not a floating bubble (P1, S, Impact 4)

**Problem:** `ChatBubble` is a floating button in the corner. New users miss it.

**Proposal:** Move chat to:
1. Persistent sidebar tab on desktop.
2. Bottom navigation icon on mobile (Home / History / Chat / Settings).
3. A "Ask AI" CTA next to every flag and DTC: "Why is this happening?" — pre-fills a prompt with the flag context.

**Files:** `src/components/AppLayout.tsx`, `src/components/ChatBubble.tsx` (replace), `src/components/FlagsPanel.tsx` (Ask AI CTA).

### Theme D — Intelligence layer

#### D1. Server-side Gemini key (P0, M, Impact 5)

**Problem:** Today users must generate their own Gemini API key, paste it in Settings, and it's stored plaintext in `app_settings`. This is friction + security debt.

**Proposal:**
- Move Gemini API key to **Supabase Edge Function** environment variable.
- Edge Function `analyze-session` exposes a server-authenticated endpoint that calls Gemini on behalf of the user.
- Rate limit per user (10 chats/day on free, unlimited on paid).
- Removes the entire "configure your API key" UX. AI becomes invisible plumbing.

**Files:** `supabase/functions/analyze-session/index.ts`, `supabase/functions/chat/index.ts`, `src/lib/ai-client.ts` (new, replaces `gemini-service.ts`), settings page cleanup.

**Tradeoff:** Costs go on you. Mitigate with rate limits and Gemini Flash pricing (cheap).

#### D2. Trend-aware AI context (P1, M, Impact 4)

**Problem:** `buildChatContext` in `src/lib/chat/db.ts` passes the last 5 sessions but no trend analysis. The AI has to re-discover patterns the rule engine already found.

**Proposal:** Build a richer `ChatContext`:
```ts
interface ChatContext {
  vehicle: { year, make, model, vin, mileage };
  recentSessions: SessionSummary[];
  trends: {
    fuel_economy: { current_avg, 30d_avg, trend: 'improving' | 'declining' };
    coolant_max: { current, 30d_max, regression_score };
    /* ... per parameter */
  };
  active_flags: SessionFlag[];   // unresolved across all sessions
  active_dtcs: string[];          // unique active DTCs
  maintenance: MaintenanceEvent[]; // last 12 months
}
```

The AI now answers "is my fuel economy getting worse?" with real numbers instead of generic guesses.

**Files:** `src/lib/chat/db.ts` (`buildChatContext`), `src/lib/trends.ts` (new).

#### D3. Automatic AI analysis on every upload (P1, S, Impact 4)

**Problem:** Today AI analysis runs only if the user configured a Gemini key. After D1 lands, this is free for the server. Make it default.

**Proposal:**
- On every session upload, the Edge Function generates a 2–3 sentence summary + a "what to watch" callout.
- Stored in `sessions.gemini_analysis` (already exists).
- Surfaced as the first card on the session detail page.
- Re-generated if the user clicks "regenerate" (paid feature on free tier).

**Files:** `supabase/functions/analyze-session/index.ts`, `src/components/AIAnalysisCard.tsx`.

#### D4. Anomaly detection vs the car's own baseline (P2, L, Impact 4)

**Problem:** Threshold rules catch "high coolant temp" but miss "your coolant temp ran 8°C higher than your own 30-day average." That's the early warning signal that matters.

**Proposal:**
- For each (car_profile, parameter) maintain rolling 7/30/90-day baselines (mean + stddev) materialized in a `parameter_baselines` table, refreshed via Postgres trigger or scheduled function.
- During flag evaluation, compute z-score for the session: flag at z > 2 (attention) or z > 3 (critical) even when within absolute thresholds.
- Display as "🔥 Hotter than usual" badges separate from absolute flags.

**Files:** `supabase/migrations/{date}_baselines.sql`, `src/lib/insight-engine.ts` (anomaly path), `src/components/AnomalyBadge.tsx`.

### Theme E — Data quality & scale

#### E1. Time-series resampling on upload (P1, M, Impact 3)

**Problem:** Raw rows stored as-is. A 1Hz session for 90 minutes = 5400 rows. A 10Hz session = 54000 rows per parameter. `session_rows` table will explode. Today silently truncated to 1000 on read (`getSessionRows`).

**Proposal:**
- During upload, downsample rows to a max of 2000 per session using LTTB (Largest-Triangle-Three-Buckets) algorithm — preserves visual shape with minimal points.
- Store the *original CSV* in storage for full fidelity (already done via `source_csv`).
- For charts, use the downsampled rows. For "view raw data", re-parse from storage.
- Removes the silent truncation problem entirely.

**Files:** `src/lib/downsample.ts` (new, LTTB ~30 lines), `src/hooks/use-csv-upload.ts`.

#### E2. Smarter health score (P1, S, Impact 3)

**Problem:** Current formula `100 - critical*15 - attention*5` is arbitrary. 7 attention flags = 65 score (Critical). A user with 8 small fuel trim hiccups shouldn't get the same score as a head gasket on the verge of failing.

**Proposal:**
- Weight by parameter severity ranking (coolant > engine load > fuel trim > intake temp).
- Weight by `pct_out_of_range` (a flag that's out 80% of the session is worse than 5%).
- Weight by recency (last week's flags > 6 months ago).
- Compute server-side in the `get_dashboard_stats` RPC already added.
- Show the *components* of the score on hover: "Score 72 = coolant (-12) + fuel trim (-8) + recency (-8)."

**Files:** `supabase/migrations/{date}_health_score_v2.sql`, `src/components/HealthGauge.tsx`.

#### E3. Real-time updates via Supabase subscriptions (P2, S, Impact 3)

**Problem:** Dashboard never updates without a refresh. If user uploads a session on another tab/device, current tab shows stale data.

**Proposal:** Subscribe to `sessions` table changes for the current car. New session → toast "New session uploaded" + refetch.

**Files:** `src/contexts/CarsContext.tsx` or new `src/hooks/use-sessions-subscription.ts`.

#### E4. Bundle splitting (P2, S, Impact 2)

**Problem:** `dist/assets/index-BaHxmH-R.js` is 500KB (150KB gzipped). Build warning every time.

**Proposal:**
- Manual chunks in `vite.config.ts`: split Recharts (388KB chunk already isolated), shadcn/Radix, Supabase client, Gemini SDK.
- Lazy-load chat system only when opened.
- Target: <300KB main bundle gzipped.

**Files:** `vite.config.ts`.

#### E5. Internationalization (P2, M, Impact 3)

**Problem:** UI is English-only. You're Brazilian; the addressable market in PT/ES is huge for OBD2 tools.

**Proposal:** Add `react-i18next` with `en`, `pt-BR`, `es-ES` translations. Most strings are short (form labels, toast messages). DTC code descriptions stay English (industry standard) with a per-language summary.

**Files:** `src/lib/i18n.ts`, `public/locales/{lang}/translation.json`, all components using `useTranslation()`.

---

## Roadmap

| Sprint | Focus | Deliverables |
|--------|-------|--------------|
| **Sprint 1 (1 wk)** — Quick credibility wins | A1 (rule library scaffold), B1 (action messages), D1 (server-side Gemini) | Rules per make/model, prescriptive flags, no more API key UX |
| **Sprint 2 (1 wk)** — DTC + Vision | A2 (DTC support), C3 (image upload + vision), D3 (auto AI analysis) | Real diagnostic codes, dashboard photos for AI |
| **Sprint 3 (1 wk)** — Mobile garage | C1 (PWA), C2 (mobile dashboard), C4 (chat prominence) | Works offline in the garage on a phone |
| **Sprint 4 (1 wk)** — Memory & context | B2 (maintenance log), D2 (trend-aware AI), E2 (better health score) | App remembers, AI uses memory |
| **Sprint 5 (1 wk)** — Polish & scale | A3 (VIN decoder), B3 (PDF reports), E1 (downsampling), E4 (bundle splitting) | Production-grade quality |
| **Sprint 6 (1 wk)** — Intelligence | D4 (anomaly detection), E3 (realtime), E5 (i18n) | Smart, live, multilingual |

**Total:** 6 weeks, 18 improvements.

## What NOT to do

- **Don't add user accounts/teams/sharing** before nailing single-user value. Sharing is improvement B3 (one-shot PDF), not a social network.
- **Don't add an in-app marketplace** for rules, repairs, or parts. Stay focused on diagnosis.
- **Don't build native iOS/Android apps**. PWA gets you 95% of the way for 5% of the cost.
- **Don't add billing/subscriptions yet.** Get the product to "shareable demo" first. Then think about monetization.
- **Don't replace Supabase.** It's the right tool. The scaling concerns in CONCERNS.md are addressable at the schema level, not by switching to Firebase or Mongo.

## Success metrics

The product is "working perfectly for what it was generated for" when:

1. A new user goes from signup → first useful diagnostic insight in **under 2 minutes**.
2. A returning user can answer "should I be worried about my car?" in **one glance** at the dashboard.
3. **80% of flags** include a concrete next action (not just a number).
4. The dashboard works offline in a **garage with weak signal**.
5. A user who doesn't know what a P0420 is can **understand it from the app alone**.
6. The AI chat is the **most-used feature** within 3 sessions, not a hidden bubble.
7. Bundle size is **under 300KB gzipped** for the main route.
8. **Zero plaintext API keys** in any database table.

---

*Synthesized from full codebase analysis, planning artifacts, and existing CONCERNS.md.*
