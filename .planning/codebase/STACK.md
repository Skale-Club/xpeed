# Technology Stack

**Analysis Date:** 2026-05-17

## Languages

**Primary:**
- TypeScript 5.8 — all application source under `src/` (`tsconfig.json` + `tsconfig.app.json`)
- JavaScript (ESM, Node.js) — keepalive scripts under `scripts/` (`*.mjs`)

**Secondary:**
- SQL — Supabase migrations under `supabase/migrations/` (12 migration files)
- TOML — Supabase project config at `supabase/config.toml`

## Runtime

**Environment:**
- Node.js 20 — pinned in GitHub Actions (`actions/setup-node@v4 node-version: "20"`)
- Browser (modern ES2020+) — production target
- No `.nvmrc` present locally; rely on CI pin

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present; CI uses `npm ci`

## Frameworks

**Core:**
- React 18.3 — UI rendering; entry at `src/main.tsx`, app tree at `src/App.tsx`
- React Router DOM 6.30 — SPA client-side routing via `BrowserRouter`; all routes defined in `src/App.tsx`

**State / Data Fetching:**
- TanStack React Query 5.83 — server-state caching; `QueryClientProvider` is the outermost wrapper in `src/App.tsx`

**UI / Styling:**
- Tailwind CSS 3.4 — utility-first styling; config at `tailwind.config.ts`
- Radix UI — full primitive set (`@radix-ui/react-*`, 23 packages); used via shadcn/ui wrappers in `src/components/ui/`
- shadcn/ui pattern — Radix primitives composed with `class-variance-authority` + `tailwind-merge`
- `tailwindcss-animate` 1.0 — CSS animation plugin; accordion and custom `pulse-glow`
- `next-themes` 0.3 — dark mode; class-based strategy
- Custom fonts: Inter (sans), JetBrains Mono (mono) — declared in `tailwind.config.ts`

**AI / Chat:**
- `@google/generative-ai` 0.24 — Google Gemini SDK; session analysis and chat in `src/lib/gemini-service.ts`
- `ai` 6.0 (Vercel AI SDK core) + `@ai-sdk/react` 3.0 — message parts format consumed by chat tables
- `react-markdown` 10.1 — renders Gemini responses as markdown in chat UI

**Forms / Validation:**
- `react-hook-form` 7.61 + `@hookform/resolvers` 3.10 — form state
- `zod` 3.25 — schema validation; resolvers bridge zod → react-hook-form

**Testing:**
- Vitest 3.2 — test runner; config at `vitest.config.ts`; `jsdom` environment; globals enabled
- `@testing-library/react` 16 + `@testing-library/jest-dom` 6 — component/DOM assertions
- jsdom 20 — simulated browser DOM
- Setup file: `src/test/setup.ts`

**Build / Dev:**
- Vite 5.4 — bundler and dev server; config at `vite.config.ts`
- `@vitejs/plugin-react-swc` 3.11 — SWC-based React transform (fast compilation, HMR overlay disabled)
- PostCSS 8.5 + autoprefixer 10.4 — CSS pipeline; config at `postcss.config.js`

**Code Quality:**
- ESLint 9.32 + `typescript-eslint` 8.38 — linting; config at `eslint.config.js`
- `eslint-plugin-react-hooks` 5.2 + `eslint-plugin-react-refresh` 0.4 — React-specific rules

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` 2.95 — all database, auth, and storage operations (`src/integrations/supabase/client.ts`)
- `@google/generative-ai` 0.24 — Gemini AI for diagnostics and chat (`src/lib/gemini-service.ts`)
- `@vercel/analytics` 1.6 — page-view analytics; `<Analytics />` rendered in `src/App.tsx`

**Infrastructure:**
- `supabase` CLI 2.76 (devDependency) — local migration management
- `dotenv` 17.2 — env loading for keepalive Node.js scripts

**UI Utilities:**
- `lucide-react` 0.462 — icon set
- `recharts` 2.15 — OBD2 parameter charts
- `sonner` 1.7 — toast notifications (alongside `@radix-ui/react-toast`)
- `date-fns` 3.6 — date formatting
- `cmdk` 1.1 — command palette
- `embla-carousel-react` 8.6 — carousel
- `vaul` 0.9 — drawer component
- `react-resizable-panels` 2.1 — resizable panel layout
- `input-otp` 1.4 — OTP input component
- `clsx` 2.1 — conditional className utility

## Configuration

**Environment (browser build):**
- `import.meta.env.VITE_SUPABASE_URL` — Supabase project URL
- `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY` — Supabase anon key
- `import.meta.env.VITE_APP_URL` — canonical app URL for OAuth redirects
- User Gemini API key is stored per-user in the `app_settings` Supabase table; NOT a build-time env var

**Environment (Node.js scripts):**
- `SUPABASE_URL` or `VITE_SUPABASE_URL` — used by keepalive scripts
- `SUPABASE_SERVICE_ROLE_KEY` — service role key for keepalive and admin scripts
- Set as GitHub Actions secrets; read via `process.env`

**Build Config Files:**
- `vite.config.ts` — dev server `0.0.0.0:5000`, HMR overlay off, `@` alias → `./src`
- `tsconfig.json` — loose mode: `noImplicitAny: false`, `strictNullChecks: false`, `@/*` path alias
- `tsconfig.app.json`, `tsconfig.node.json` — referenced split configs
- `tailwind.config.ts` — custom colors (sidebar, warn, success tokens), custom animations
- `postcss.config.js` — tailwindcss + autoprefixer plugins
- `vercel.json` — catch-all rewrite `/(.*) → /index.html` for SPA routing
- `vitest.config.ts` — jsdom environment, globals, `@` alias, setup file

## Platform Requirements

**Development:**
- Node.js 20+
- `npm install` then `npm run dev` (serves on `http://localhost:5000`)

**Production:**
- Hosted on Vercel as an SPA
- Build: `vite build` → output to `dist/`
- Backend: Supabase hosted PostgreSQL + Auth + Storage (project ID: `drqmrddxlrlbqnydumjm`)

---

*Stack analysis: 2026-05-17*
