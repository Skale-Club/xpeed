# Codebase Structure

**Analysis Date:** 2026-05-17

## Directory Layout

```
car-insights-ai/
├── src/
│   ├── main.tsx                    # App bootstrap, mounts <App /> into #root
│   ├── App.tsx                     # Root providers + route definitions
│   ├── App.css                     # Global CSS resets
│   ├── index.css                   # Tailwind directives + CSS variables (theme tokens)
│   ├── vite-env.d.ts               # Vite env type declarations
│   │
│   ├── pages/                      # Route-level components (lazy-loaded)
│   │   ├── Index.tsx               # Dashboard — health overview, sessions, trends
│   │   ├── SessionDetail.tsx       # Single session — KPIs, flags, charts, AI analysis
│   │   ├── HistoryPage.tsx         # Full session history list
│   │   ├── CarsPage.tsx            # Car profile management CRUD
│   │   ├── SettingsPage.tsx        # User settings (Gemini API key, model, units)
│   │   ├── LoginPage.tsx           # Email + Google login
│   │   ├── SignupPage.tsx          # New account signup
│   │   ├── SetupAdminPage.tsx      # One-time admin profile setup
│   │   └── NotFound.tsx            # 404 fallback
│   │
│   ├── components/                 # Feature components
│   │   ├── AppLayout.tsx           # Authenticated shell: header, nav, footer, ChatBubble
│   │   ├── PrivateRoute.tsx        # Auth guard — redirects to /login if unauthenticated
│   │   ├── ChatBubble.tsx          # FAB toggling ChatContainer
│   │   ├── UploadCard.tsx          # Drag-and-drop CSV uploader, uses useCSVUpload
│   │   ├── DashboardCharts.tsx     # Recharts line/bar charts over filtered sessions
│   │   ├── LatestTripCard.tsx      # Summary card for the most recent session
│   │   ├── GeneralInfoCard.tsx     # Cumulative distance, fuel, problem count KPIs
│   │   ├── SessionKPIs.tsx         # Per-session metric cards (used in SessionDetail)
│   │   ├── SessionCharts.tsx       # Time-series charts for a single session's rows
│   │   ├── FlagsPanel.tsx          # Diagnostic flag list with severity badges
│   │   ├── AIAnalysisCard.tsx      # Renders gemini_analysis JSON (summary, insights, recs)
│   │   ├── NavLink.tsx             # Styled router link wrapper
│   │   ├── PageLoader.tsx          # Centered spinner for Suspense fallback
│   │   │
│   │   ├── chat/                   # Self-contained AI chat feature
│   │   │   ├── ChatContainer.tsx   # Orchestrator: state, Gemini calls, conversation mgmt
│   │   │   ├── ChatInput.tsx       # Textarea + send button
│   │   │   ├── ChatSidebar.tsx     # Conversation list with select/delete actions
│   │   │   └── MessageList.tsx     # Message bubble renderer (user/assistant)
│   │   │
│   │   └── ui/                     # shadcn/ui primitives (auto-generated, do not edit)
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── dialog.tsx
│   │       ├── dropdown-menu.tsx
│   │       ├── input.tsx
│   │       ├── select.tsx
│   │       ├── toast.tsx
│   │       ├── toaster.tsx
│   │       ├── sonner.tsx
│   │       ├── progress.tsx
│   │       ├── chart.tsx           # Recharts wrapper with theme tokens
│   │       └── ...                 # (30+ additional shadcn primitives)
│   │
│   ├── contexts/                   # React context providers
│   │   ├── AuthContext.tsx         # user, session, loading, signIn, signOut, etc.
│   │   ├── CarsContext.tsx         # Thin wrapper around useCars hook
│   │   └── SettingsContext.tsx     # distanceUnit, timezone (localStorage-backed)
│   │
│   ├── hooks/                      # Custom React hooks
│   │   ├── use-cars.ts             # Car list state + localStorage selection persistence
│   │   ├── use-csv-upload.ts       # Full CSV → session ingestion pipeline
│   │   ├── use-toast.ts            # Re-export of shadcn useToast
│   │   └── use-mobile.tsx          # Responsive breakpoint detection
│   │
│   ├── lib/                        # Domain logic + service layer
│   │   ├── db.ts                   # All Supabase queries: sessions, cars, flags, storage, AI settings
│   │   ├── csv-parser.ts           # OBD2 CSV parser (wide + long/pivot formats)
│   │   ├── canonical-params.ts     # OBD2 header → canonical key mapping table
│   │   ├── insight-engine.ts       # computeParameterSummaries(), evaluateRules()
│   │   ├── default-rules.ts        # Hardcoded Prius diagnostic thresholds
│   │   ├── gemini-service.ts       # analyzeSession(), validateApiKey(), chatWithVehicleData()
│   │   ├── utils.ts                # cn() Tailwind class merger (clsx + tailwind-merge)
│   │   │
│   │   └── chat/                   # Chat feature services
│   │       ├── db.ts               # Supabase CRUD for conversations + messages + buildChatContext()
│   │       └── types.ts            # ChatMessage, ChatConversation, ChatContext, MessagePart types + helpers
│   │
│   ├── integrations/
│   │   └── supabase/
│   │       ├── client.ts           # Singleton supabase client (auto-generated)
│   │       └── types.ts            # Generated TypeScript types for all DB tables
│   │
│   ├── scripts/                    # One-off utility scripts (run with tsx/ts-node, not part of app bundle)
│   │   └── (see scripts/ at root)
│   │
│   └── test/
│       ├── setup.ts                # Vitest test setup
│       └── example.test.ts         # Placeholder test
│
├── supabase/
│   ├── migrations/                 # SQL migration files applied to Supabase
│   │   ├── 20260206193301_*.sql    # Initial schema: car_profiles, sessions, session_rows, parameter_rules, session_flags
│   │   ├── 20260209095500_gemini_integration.sql     # app_settings table, sessions.gemini_analysis column
│   │   ├── 20260209104400_multi_car_support.sql      # user_id on car_profiles + sessions, user-scoped RLS
│   │   ├── 20260209105600_auth_setup.sql             # Full RLS policy set for all tables, set_user_id() trigger
│   │   ├── 20260209110700_admin_support.sql          # Admin role support
│   │   ├── 20260209111600_add_is_admin_column.sql    # is_admin column on car_profiles
│   │   ├── 20260209182800_add_resolved_to_flags.sql  # resolved BOOL column on session_flags
│   │   ├── 20260219104900_add_source_csv_column.sql  # sessions.source_csv TEXT column
│   │   ├── 20260219105200_session_csv_storage.sql    # session-csv storage bucket setup
│   │   ├── 20260219161400_google_oauth.sql           # Google OAuth provider setup
│   │   ├── 20260219161500_google_oauth_fix.sql       # OAuth redirect URL fix
│   │   └── 20260308_chat_system.sql                  # chat_conversations + chat_messages tables, RLS, triggers
│   └── config.toml                 # Supabase CLI project config
│
├── scripts/                        # Dev/admin scripts (not bundled)
│   ├── supabase-keepalive.mjs      # Pings Supabase to prevent free-tier pause
│   ├── supabase-keepalive-verify.mjs # Verifies keepalive is working
│   ├── apply-resolved-migration.ts # One-off: applies resolved column migration
│   ├── run-migration.ts            # Generic migration runner
│   ├── recreate-admin.ts           # Recreates admin car profile
│   ├── inspect-summaries.ts        # Debug: prints session summaries
│   ├── inspect-summary.ts          # Debug: prints single session summary
│   ├── check_migration_capability.ts # Checks migration permissions
│   └── test-parser.ts              # Manual CSV parser test runner
│
├── public/
│   └── logo.svg                    # App logo
│
├── .planning/
│   └── codebase/                   # GSD architecture documents (this file)
│
├── package.json                    # Dependencies and scripts
├── vite.config.ts                  # Vite build config with path alias @/ → src/
├── tailwind.config.ts              # Tailwind theme (extends with custom colors, fonts)
├── tsconfig.json                   # TypeScript config (references app + node)
├── tsconfig.app.json               # App TypeScript config
├── tsconfig.node.json              # Node TypeScript config (for vite.config, scripts)
├── vitest.config.ts                # Vitest test runner config
├── eslint.config.js                # ESLint flat config
├── postcss.config.js               # PostCSS (Tailwind + autoprefixer)
├── components.json                 # shadcn/ui CLI config (style, paths, aliases)
└── vercel.json                     # Vercel deployment config (SPA rewrite rules)
```

---

## Directory Purposes

### `src/pages/`
Route-level components. Each corresponds to one route in `App.tsx`. They:
- Fetch their own data via `useEffect` + `useState` calling `src/lib/db.ts`.
- Consume `useCarsContext()` for the selected car and `useSettings()` for display preferences.
- Are all lazy-loaded with `React.lazy`.

### `src/components/`
Feature components that are not route-level. Subdivided:
- Root level: shared feature components used across multiple pages (e.g., `AppLayout`, `UploadCard`, `FlagsPanel`).
- `chat/`: fully self-contained chat feature — all four components are only used together.
- `ui/`: shadcn/ui primitives. Never edit these directly; regenerate via `npx shadcn-ui add`.

### `src/contexts/`
React Context providers. Import pattern:
```typescript
import { useAuth } from '@/contexts/AuthContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
```

### `src/hooks/`
Custom hooks with non-trivial state. Key rule: hooks may call `src/lib/db.ts` but do NOT call Supabase directly.

### `src/lib/`
Two distinct sub-categories:
- **Domain logic** (`csv-parser.ts`, `canonical-params.ts`, `insight-engine.ts`, `default-rules.ts`): pure functions, no external dependencies beyond each other.
- **Service/data access** (`db.ts`, `gemini-service.ts`, `chat/db.ts`): async functions with Supabase or Gemini API calls.

### `src/integrations/supabase/`
Auto-generated by Supabase CLI. Do not edit `client.ts` or `types.ts` by hand; regenerate with `supabase gen types typescript`.

### `supabase/migrations/`
Sequential SQL migration files. Applied in filename order. Each migration is additive — do not edit previously applied migrations; add new ones.

### `scripts/`
Dev-only utilities run with `npx tsx scripts/filename.ts`. Not part of the app bundle. Used for database inspection, admin setup, and keepalive maintenance.

---

## Key File Locations

**App entry:**
- `src/main.tsx` — Vite entry point
- `src/App.tsx` — provider tree + router

**Auth gate:**
- `src/components/PrivateRoute.tsx`
- `src/contexts/AuthContext.tsx`

**Car selection (global):**
- `src/contexts/CarsContext.tsx`
- `src/hooks/use-cars.ts`

**All Supabase queries:**
- `src/lib/db.ts` — primary (sessions, cars, flags, AI settings)
- `src/lib/chat/db.ts` — chat feature

**CSV processing:**
- `src/lib/csv-parser.ts` → `src/lib/canonical-params.ts` → `src/lib/insight-engine.ts` → `src/lib/default-rules.ts`
- `src/hooks/use-csv-upload.ts` — pipeline orchestrator

**AI / Gemini:**
- `src/lib/gemini-service.ts` — upload-time analysis
- `src/components/chat/ChatContainer.tsx` — interactive chat (inline Gemini call)

**Chat feature:**
- `src/components/ChatBubble.tsx` — entry FAB
- `src/components/chat/ChatContainer.tsx` — state + logic
- `src/components/chat/ChatSidebar.tsx` — conversation list
- `src/components/chat/MessageList.tsx` — message rendering
- `src/components/chat/ChatInput.tsx` — input box
- `src/lib/chat/db.ts` — Supabase CRUD
- `src/lib/chat/types.ts` — TypeScript types

**Theme / Styling:**
- `src/index.css` — CSS custom properties (design tokens)
- `tailwind.config.ts` — Tailwind theme extension

**Database schema:**
- `supabase/migrations/` — all migrations in order

---

## Naming Conventions

**Files:**
- Pages: PascalCase with `Page` suffix where ambiguous — `SettingsPage.tsx`, `CarsPage.tsx`, `LoginPage.tsx`. Entry page is `Index.tsx`.
- Components: PascalCase — `AppLayout.tsx`, `ChatContainer.tsx`, `FlagsPanel.tsx`.
- Hooks: kebab-case with `use-` prefix — `use-cars.ts`, `use-csv-upload.ts`.
- Lib utilities: kebab-case — `csv-parser.ts`, `insight-engine.ts`, `default-rules.ts`.
- Context files: PascalCase with `Context` suffix — `AuthContext.tsx`, `CarsContext.tsx`.

**Exports:**
- Pages: `export default`.
- Components: mix of named and default exports (most feature components use `export default`; shadcn/ui components use named exports).
- Hooks: named export — `export function useCars()`.
- Context hooks: named export — `export function useAuth()`, `export function useCarsContext()`.
- Lib functions: named exports.

---

## Where to Add New Code

**New page/route:**
1. Create `src/pages/NewPage.tsx` with `export default`.
2. Add `const NewPage = lazy(() => import('./pages/NewPage'))` in `src/App.tsx`.
3. Add `<Route path="/new" element={<AuthenticatedLayout><NewPage /></AuthenticatedLayout>} />`.
4. Add nav item to `NAV_ITEMS` array in `src/components/AppLayout.tsx` if needed.

**New feature component:**
- Stateless or lightly stateful UI: `src/components/MyFeature.tsx`
- Chat sub-component: `src/components/chat/MyComponent.tsx`
- shadcn/ui primitive: `npx shadcn-ui add <component>` → auto-places in `src/components/ui/`

**New database query function:**
- Session/car/flag related → add to `src/lib/db.ts`
- Chat related → add to `src/lib/chat/db.ts`
- Export as a named async function following the existing pattern: call `supabase`, handle error by throwing.

**New Supabase table or schema change:**
- Create a new migration file: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
- Run via Supabase CLI or `scripts/run-migration.ts`
- Regenerate TypeScript types: `supabase gen types typescript --project-id <id> > src/integrations/supabase/types.ts`

**New custom hook:**
- Add `src/hooks/use-my-feature.ts`
- Pattern: export a single named function `export function useMyFeature() { ... }`
- May call `src/lib/db.ts` functions; do NOT import from `@/integrations/supabase/client` directly.

**New context:**
- Add `src/contexts/MyContext.tsx` with `Provider` component and `useMyContext()` hook.
- Mount the provider in `src/App.tsx` at the appropriate level (global → inside `QueryClientProvider`; auth-only → inside `AuthenticatedLayout`).

**New diagnostic rule:**
- Add to `src/lib/default-rules.ts` following the `Rule` interface from `src/lib/insight-engine.ts`.
- Canonical key must be defined in `src/lib/canonical-params.ts`.

---

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD architecture documents for AI-assisted development.
- Generated: Yes (by GSD map-codebase).
- Committed: Yes.

**`supabase/migrations/`:**
- Purpose: Ordered SQL migrations for Supabase Postgres.
- Generated: No — hand-written.
- Committed: Yes — source of truth for schema.

**`src/components/ui/`:**
- Purpose: shadcn/ui component library (Radix UI + Tailwind wrappers).
- Generated: Yes — via `npx shadcn-ui add`.
- Committed: Yes — customization expected.

**`src/integrations/supabase/`:**
- Purpose: Auto-generated Supabase client and TypeScript DB types.
- Generated: Yes — via Supabase CLI.
- Committed: Yes — types must stay in sync with DB schema.

**`scripts/`:**
- Purpose: Dev/admin scripts (not bundled into the app).
- Generated: No.
- Committed: Yes.

---

*Structure analysis: 2026-05-17*
