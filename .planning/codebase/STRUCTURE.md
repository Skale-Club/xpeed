# Codebase Structure

**Analysis Date:** 2026-05-29

## Directory Layout

```
xpeed/
├── src/                        # React SPA source
│   ├── main.tsx                # Entry point — mounts React root, registers vite:preloadError
│   ├── App.tsx                 # Provider tree + React Router route definitions
│   ├── App.css                 # Global CSS overrides
│   ├── index.css               # Tailwind base + CSS variables (dark theme)
│   ├── vite-env.d.ts           # Vite env type shims
│   ├── pages/                  # Route-level page components (one per route)
│   ├── components/             # Reusable React components
│   │   ├── ui/                 # Shadcn/ui primitives (auto-generated, do not edit)
│   │   ├── admin/              # Admin-only components (BrandingSection)
│   │   └── chat/               # Chat UI sub-components
│   ├── contexts/               # React Context providers (auth, cars, settings)
│   ├── hooks/                  # Custom React hooks (data fetching, UI utilities)
│   ├── lib/                    # Business logic, data access, utilities
│   │   ├── default-rules/      # Static OBD2 ruleset files per vehicle model
│   │   └── chat/               # Chat-specific DB helpers and types
│   ├── integrations/
│   │   └── supabase/           # Generated Supabase client + type definitions
│   ├── locales/                # i18n translation files (en, pt-BR, es-ES)
│   ├── types/                  # Shared TypeScript domain types
│   ├── scripts/                # One-off admin scripts (create-admin.ts)
│   └── test/                   # Test setup and example tests
│
├── supabase/                   # Supabase backend
│   ├── migrations/             # 46 SQL migration files (schema history)
│   ├── functions/              # Deno Edge Functions
│   │   ├── _shared/            # Shared Deno modules (quota.ts, admin-config.ts)
│   │   ├── analyze-session/    # AI session analysis (Gemini)
│   │   ├── chat/               # AI chat (Gemini)
│   │   ├── mcp-server/         # MCP JSON-RPC 2.1 server
│   │   │   ├── services/       # Data service modules (cars, sessions, dtc, maintenance)
│   │   │   └── tools/          # MCP tool definitions
│   │   ├── xpeed-oauth/        # OAuth 2.1 server (PKCE, JWT, refresh tokens)
│   │   ├── manage-mcp-tokens/  # MCP token management
│   │   ├── car-insights-mcp/   # MCP variant
│   │   └── xpeed-mcp/          # MCP variant
│   ├── config.toml             # Supabase project config
│   └── setup_db.sql            # Legacy setup script (superseded by migrations)
│
├── api/                        # Vercel Edge Function API routes
│   ├── brand/
│   │   └── manifest.ts         # Dynamic PWA web manifest (reads brand config from DB)
│   ├── oauth/
│   │   ├── issue-code.ts       # Proxy → xpeed-oauth/issue-code
│   │   ├── register.ts         # Proxy → xpeed-oauth/register
│   │   └── token.ts            # Proxy → xpeed-oauth/token
│   ├── wellknown/
│   │   ├── oauth-authorization-server.ts  # OAuth 2.1 discovery metadata
│   │   └── oauth-protected-resource.ts   # OAuth protected resource metadata
│   └── mcp.ts                  # MCP proxy endpoint
│
├── public/                     # Static assets served as-is
├── plans/                      # Legacy planning docs (superseded by .planning/)
├── scripts/                    # Shell/Node utility scripts
├── .planning/                  # GSD planning system
│   ├── codebase/               # Codebase analysis docs (this file lives here)
│   ├── phases/                 # Implementation phase plans
│   ├── research/               # Research notes
│   └── seeds/                  # Seed data / initial state docs
├── index.html                  # Vite HTML entry
├── package.json                # Dependencies and scripts
├── vite.config.ts              # Vite build config (path alias @/ → src/)
├── vitest.config.ts            # Vitest test config
├── tsconfig.json               # TypeScript config (project references)
├── tsconfig.app.json           # App-specific TS config
├── tailwind.config.ts          # Tailwind config (dark mode, custom colors)
├── components.json             # Shadcn/ui component config
├── vercel.json                 # Vercel routing rules (SPA fallback, manifest route)
└── eslint.config.js            # ESLint config
```

## Directory Purposes

**`src/pages/`:**
- Purpose: One file per route; page components orchestrate data loading and user interaction
- Contains: 17 page components
- Key files:
  - `src/pages/Index.tsx` — dashboard (stats, charts, latest session, flags, upload)
  - `src/pages/SessionDetail.tsx` — full session view (KPIs, flags, charts, AI analysis, photos)
  - `src/pages/CarsPage.tsx` — vehicle management
  - `src/pages/HistoryPage.tsx` — session list with filters
  - `src/pages/MaintenancePage.tsx` — maintenance log CRUD
  - `src/pages/VehicleIssuesPage.tsx` — persistent issue tracker
  - `src/pages/AdminPage.tsx` — system settings + branding (admin-only)
  - `src/pages/OnboardingPage.tsx` — first-run wizard for new users
  - `src/pages/OAuthAuthorize.tsx` — OAuth 2.1 user consent screen
  - `src/pages/SharedReport.tsx` — public shared diagnostic report (no auth)
  - `src/pages/ShareImportPage.tsx` — import a shared session

**`src/components/`:**
- Purpose: Reusable UI components consumed by pages
- Key files:
  - `src/components/AppLayout.tsx` — shell: SidebarProvider + AppSidebar + ChatBubble + PWAInstallPrompt
  - `src/components/AppSidebar.tsx` — main nav (Dashboard, Issues, History, Cars, Maintenance, Settings) + car switcher
  - `src/components/PrivateRoute.tsx` — auth guard; redirects to `/login` if no user
  - `src/components/UploadCard.tsx` — CSV file drag-drop + upload trigger
  - `src/components/AIAnalysisCard.tsx` — Gemini analysis display + trigger
  - `src/components/OnboardingWizard.tsx` — multi-step first-run wizard
  - `src/components/BrandHead.tsx` — injects dynamic brand favicon/title/theme-color into `<head>`
  - `src/components/DashboardCharts.tsx` — health trend bar charts
  - `src/components/SessionCharts.tsx` — per-session time series charts
  - `src/components/HealthGauge.tsx` — circular health score gauge
  - `src/components/FlagsPanel.tsx` — session flags list with severity badges
  - `src/components/DTCPanel.tsx` — DTC code display with lookup
  - `src/components/McpTokensSection.tsx` — MCP token management UI
  - `src/components/chat/ChatContainer.tsx` — chat panel with history
  - `src/components/ui/` — Shadcn/ui primitives (40+ components); generated, never hand-edited

**`src/contexts/`:**
- Purpose: React Context providers for global state
- Key files:
  - `src/contexts/AuthContext.tsx` — auth state + signIn/signOut/signInWithGoogle/resetPassword
  - `src/contexts/CarsContext.tsx` — car list + selectedCar; wraps `use-cars.ts`
  - `src/contexts/SettingsContext.tsx` — distanceUnit (km/mi) + timezone; persists to localStorage

**`src/hooks/`:**
- Purpose: Stateful data fetching and reusable UI logic
- Key files:
  - `src/hooks/use-cars.ts` — car profile CRUD + selectedCarId state
  - `src/hooks/use-csv-upload.ts` — full 12-step OBD2 session upload pipeline
  - `src/hooks/use-admin-status.ts` — admin role check with module-level cache
  - `src/hooks/use-brand.ts` — loads brand config from DB
  - `src/hooks/use-view-mode.ts` — simple/advanced mode toggle (persisted in localStorage)

**`src/lib/`:**
- Purpose: All business logic and data access; no React in this layer
- Key files:
  - `src/lib/db.ts` — primary Supabase data access (sessions, cars, flags, rows, app_settings)
  - `src/lib/db-extras.ts` — extended data access (maintenance, photos, shared reports, dashboard RPC, admin settings, vehicle_issues v2, baselines)
  - `src/lib/db-issues.ts` — vehicle_issues CRUD (v1 schema variant)
  - `src/lib/csv-parser.ts` — OBD2 CSV parsing; canonical key mapping; DTC extraction
  - `src/lib/canonical-params.ts` — column name → canonical key normalization dictionary
  - `src/lib/insight-engine.ts` — `computeParameterSummaries()` + `evaluateRules()`: the core rule engine
  - `src/lib/rule-resolver.ts` — vehicle-aware ruleset selection
  - `src/lib/default-rules.ts` — re-exports default Prius rules (legacy entry point)
  - `src/lib/default-rules/` — 7 ruleset files + 3 generic engine-type fallbacks
  - `src/lib/report-generator.ts` — assembles versioned `SessionReport` struct
  - `src/lib/issue-reconciler.ts` — upserts `vehicle_issues` rows after session processing
  - `src/lib/trends.ts` — parameter trend computation for AI context
  - `src/lib/ai-client.ts` — client-side wrappers for `analyze-session` and `chat` Edge Functions
  - `src/lib/mcp-tokens.ts` — MCP token CRUD
  - `src/lib/brand.ts` — brand asset pipeline (resize → upload → config persistence)
  - `src/lib/vehicle-library.ts` — NHTSA API + `vehicle_makes_cache` table
  - `src/lib/dashboard-config.ts` — dashboard layout/configuration
  - `src/lib/chart-palette.ts` — chart color palette utilities
  - `src/lib/downsample.ts` — session row downsampling before DB insert
  - `src/lib/dtc-codes.ts` — DTC code lookup dictionary
  - `src/lib/vin-decoder.ts` — VIN parsing utilities
  - `src/lib/i18n.ts` — i18next initialization
  - `src/lib/logout.ts` — sign-out + cache clear helper
  - `src/lib/utils.ts` — `cn()` Tailwind class merge utility

**`src/integrations/supabase/`:**
- Purpose: Auto-generated Supabase integration files; do not hand-edit
- Key files:
  - `src/integrations/supabase/client.ts` — singleton `supabase` client (localStorage session, autoRefreshToken)
  - `src/integrations/supabase/types.ts` — generated TypeScript types from DB schema

**`src/types/`:**
- Purpose: Shared domain TypeScript type definitions
- Key files:
  - `src/types/session.ts` — Session, SessionFlag, SessionRow, SessionSummary, SessionSummaryItem, DashboardProblem

**`src/locales/`:**
- Purpose: i18n translation JSON files
- Files: `en.json`, `pt-BR.json`, `es-ES.json`

**`supabase/migrations/`:**
- Purpose: Full migration history — 46 SQL files, all schema changes tracked here
- Migration phases:
  - `20260206*` — initial schema
  - `20260209*` — Gemini integration, multi-car support, auth setup, admin support, resolved flags
  - `20260219*` — CSV storage, Google OAuth
  - `20260308*` — chat system (conversations + messages)
  - `20260517*` — major feature batch: extended car profiles, dashboard stats RPC, security fixes, rule library tables, maintenance log, baselines+DTCs, session photos, shared reports, health score v2, admin secrets, user quotas
  - `20260522*` — MCP tokens
  - `20260526*` + `20260527*` — admin grants, data fixes, OAuth server tables, brand assets bucket
  - `20260528*` — vehicle library cache, session report column, session versioning, vehicle_issues v2, security hardening, anon RLS fixes

**`supabase/functions/`:**
- Purpose: Deno Edge Functions for server-side logic
- Key directories:
  - `supabase/functions/analyze-session/` — Gemini session analysis
  - `supabase/functions/chat/` — Gemini conversational AI
  - `supabase/functions/mcp-server/` — MCP JSON-RPC 2.1 server with services/ and tools/ subdirectories
  - `supabase/functions/xpeed-oauth/` — OAuth 2.1 authorization server
  - `supabase/functions/_shared/` — shared Deno modules imported by multiple functions

**`api/`:**
- Purpose: Vercel Edge Function routes (TypeScript, deployed as Vercel serverless)
- Vercel routes are defined in `vercel.json`; all unmatched paths fall back to `index.html` (SPA routing)

## Key File Locations

**Entry Points:**
- `src/main.tsx` — React DOM mount + error handler
- `src/App.tsx` — Provider tree + all route definitions
- `index.html` — Vite HTML shell

**Configuration:**
- `vite.config.ts` — build config, `@/` alias → `src/`
- `tailwind.config.ts` — dark mode, color tokens
- `components.json` — Shadcn/ui settings
- `vercel.json` — Vercel routing rules
- `supabase/config.toml` — Supabase project config

**Core Logic:**
- `src/lib/insight-engine.ts` — OBD2 rule evaluation
- `src/lib/csv-parser.ts` — CSV ingestion
- `src/lib/rule-resolver.ts` — ruleset selection
- `src/lib/report-generator.ts` — session report assembly
- `src/lib/issue-reconciler.ts` — issue lifecycle management
- `src/hooks/use-csv-upload.ts` — complete upload orchestration

**Data Access:**
- `src/lib/db.ts` — core tables
- `src/lib/db-extras.ts` — extended tables + RPCs
- `src/integrations/supabase/client.ts` — Supabase client singleton

**AI:**
- `src/lib/ai-client.ts` — client-side AI wrappers
- `supabase/functions/analyze-session/index.ts` — server-side session analysis
- `supabase/functions/chat/index.ts` — server-side chat
- `supabase/functions/_shared/admin-config.ts` — API key resolution
- `supabase/functions/_shared/quota.ts` — rate limiting

**Testing:**
- `src/test/setup.ts` — Vitest setup
- `src/test/example.test.ts` — example test
- `vitest.config.ts` — test runner config

## Naming Conventions

**Files:**
- Pages: PascalCase, descriptive noun + "Page" suffix — `CarsPage.tsx`, `MaintenancePage.tsx`
- Components: PascalCase noun — `AppLayout.tsx`, `HealthGauge.tsx`
- Hooks: `use-kebab-case.ts` — `use-csv-upload.ts`, `use-admin-status.ts`
- Lib utilities: `kebab-case.ts` — `csv-parser.ts`, `insight-engine.ts`, `rule-resolver.ts`
- Context providers: PascalCase + "Context" — `AuthContext.tsx`, `CarsContext.tsx`
- Types: PascalCase in `src/types/` — `session.ts`

**Directories:**
- Source: lowercase plural nouns — `pages/`, `components/`, `hooks/`, `contexts/`, `lib/`, `types/`
- Supabase: lowercase with hyphens — `analyze-session/`, `mcp-server/`, `_shared/`

## Where to Add New Code

**New page/route:**
1. Create `src/pages/NewFeaturePage.tsx`
2. Add `lazy(() => import('./pages/NewFeaturePage'))` in `src/App.tsx`
3. Add `<Route path="/new-feature" element={<AuthenticatedLayout><NewFeaturePage /></AuthenticatedLayout>} />` in `src/App.tsx`
4. Add nav item to `NAV_ITEMS` in `src/components/AppSidebar.tsx`

**New database table:**
1. Create `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
2. Add helper functions to `src/lib/db.ts` or `src/lib/db-extras.ts`
3. Regenerate types: `supabase gen types typescript --linked > src/integrations/supabase/types.ts`

**New vehicle ruleset:**
1. Create `src/lib/default-rules/make-model.ts` following existing patterns
2. Add to `RULESETS` array in `src/lib/rule-resolver.ts` (most specific first)

**New Edge Function:**
1. Create `supabase/functions/function-name/index.ts`
2. Import `_shared/quota.ts` and `_shared/admin-config.ts` if needed
3. If it needs a client-side wrapper, add to `src/lib/ai-client.ts` or a new lib file

**New Vercel API route:**
1. Create `api/path/handler.ts` with `export const config = { runtime: 'edge' }`
2. Add route to `vercel.json` if not auto-discovered

**New UI component:**
- Feature-specific: `src/components/ComponentName.tsx`
- Admin-only: `src/components/admin/ComponentName.tsx`
- Chat-specific: `src/components/chat/ComponentName.tsx`
- Primitive (Shadcn): `src/components/ui/component-name.tsx` (use `npx shadcn-ui@latest add <name>`)

**New hook:**
- `src/hooks/use-feature-name.ts`
- If it wraps a context, expose it as both the hook and via a Context provider (see CarsContext pattern)

**Shared types:**
- Domain types: `src/types/session.ts` or new file in `src/types/`
- DB-layer types: export interfaces directly from `src/lib/db.ts` or `src/lib/db-extras.ts`

## Special Directories

**`src/components/ui/`:**
- Purpose: Shadcn/ui primitive components
- Generated: Yes (via `npx shadcn-ui@latest add`)
- Committed: Yes
- Convention: Do not hand-edit; prefer wrapping in feature components

**`src/integrations/supabase/`:**
- Purpose: Auto-generated Supabase client and type definitions
- Generated: Yes (via `supabase gen types`)
- Committed: Yes
- Convention: Never hand-edit `types.ts`; regenerate when schema changes

**`supabase/.temp/`:**
- Purpose: Supabase CLI temporary files (linked project ref, version cache)
- Generated: Yes
- Committed: Yes (project ref needed for CLI operations)

**`.planning/`:**
- Purpose: GSD planning system — codebase analysis docs, phase plans, research
- Generated: Yes (by GSD commands)
- Committed: Yes

**`.kilo/worktrees/`:**
- Purpose: Git worktrees for parallel development branches
- Generated: Yes (by kilo/git)
- Committed: Partially (worktree metadata)

---

*Structure analysis: 2026-05-29*
