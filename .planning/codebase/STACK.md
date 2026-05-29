# Technology Stack

**Analysis Date:** 2026-05-29

## Languages

**Primary:**
- TypeScript 5.8 - Frontend SPA (`src/`) and Vercel Edge Functions (`api/`)
- TypeScript (Deno) - Supabase Edge Functions (`supabase/functions/`)

**Secondary:**
- JavaScript (ESM) - Utility scripts (`scripts/*.mjs`)
- SQL - Database migrations (`supabase/migrations/`)

## Runtime

**Environment:**
- Browser (React SPA, ES2020 target)
- Node.js 20 - Scripts and CI/CD (`scripts/`)
- Deno (Supabase Edge runtime) - All Edge Functions under `supabase/functions/`
- Vercel Edge Runtime - Thin proxy functions under `api/`

**Package Manager:**
- Bun (primary) - `bun.lockb` present
- npm also supported (CI uses `npm ci`)
- Lockfile: `bun.lockb`

## Frameworks

**Core:**
- React 18.3 - UI framework (`src/`)
- React Router DOM 6.30 - Client-side routing (`src/App.tsx`)
- TanStack Query 5.83 - Server state and caching (used across pages/components)

**UI Component System:**
- shadcn/ui - Component library built on Radix UI (`src/components/ui/`)
- Radix UI - Primitive components (accordion, dialog, dropdown, select, tabs, tooltip, etc.)
- Tailwind CSS 3.4 - Utility-first styling (`tailwind.config.ts`, `src/index.css`)
- tailwind-merge + class-variance-authority - Dynamic class composition
- next-themes 0.3 - Dark/light theme management
- Lucide React 0.462 - Icon library
- Recharts 2.15 - Data visualization (`src/components/SessionCharts.tsx`, `src/components/DashboardCharts.tsx`)

**Forms:**
- react-hook-form 7.61 - Form state management
- @hookform/resolvers 3.10 - Zod integration
- zod 3.25 - Schema validation

**AI / SDK:**
- @ai-sdk/react 3.0 + ai 6.0 - Vercel AI SDK React hooks layer
- @google/generative-ai 0.24 - Google Gemini SDK (used in Edge Functions)
- Default model: `gemini-2.5-flash` (admin-configurable via `app_settings` DB row, key `admin_gemini_model`)
- AI key stored in DB (`app_settings`, key `admin_secret_gemini_api_key`) with env fallback `GEMINI_API_KEY`

**Internationalization:**
- i18next 26.2 + react-i18next 17.0 - Translation framework (`src/lib/i18n.ts`)
- i18next-browser-languagedetector 8.2 - Auto-detect browser language
- Supported locales: `en`, `pt-BR`, `es-ES` (`src/locales/`)

**PWA:**
- vite-plugin-pwa 1.3 - Service worker, Web App Manifest, offline caching (`vite.config.ts`)
- Workbox strategy: NetworkFirst for Supabase REST reads (4s timeout, 24h cache), CacheFirst for NHTSA VIN API (30d cache)
- Share target: POST to `/import` accepts CSV files
- Dynamic manifest served via Vercel Edge Function `api/brand/manifest.ts` (admin-brandable icons)

**Testing:**
- Vitest 3.2 - Test runner
- @testing-library/react 16.0 - React component testing
- @testing-library/jest-dom 6.6 - DOM matchers
- jsdom 20 - Browser environment simulation

**Build/Dev:**
- Vite 5.4 - Bundler and dev server (`vite.config.ts`)
- @vitejs/plugin-react-swc 3.11 - SWC-based React transform (fast HMR)
- Manual chunks: `recharts`, `radix-ui`, `supabase`, `gemini`, `i18n`
- Dev server: port 5000, proxy `/api/mcp` → Supabase Edge Function in development

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` 2.95 - Database client, auth, storage, Edge Function invocation (`src/integrations/supabase/client.ts`)
- `react-router-dom` 6.30 - All navigation and protected route logic (`src/App.tsx`)
- `@tanstack/react-query` 5.83 - Data fetching pattern used throughout pages
- `zod` 3.25 - Schema validation for forms and data

**Infrastructure:**
- `@vercel/analytics` 1.6 - Page view tracking injected in `src/App.tsx`
- `date-fns` 3.6 - Date formatting throughout the app
- `react-markdown` 10.1 - Renders AI analysis text as Markdown
- `sonner` 1.7 - Toast notifications (via `src/components/ui/sonner.tsx`)
- `embla-carousel-react` 8.6 - Carousel component
- `vaul` 0.9 - Drawer/bottom sheet component
- `cmdk` 1.1 - Command palette component
- `react-day-picker` 8.10 - Date picker for maintenance log
- `react-resizable-panels` 2.1 - Resizable panel layouts
- `input-otp` 1.4 - OTP input component

## Configuration

**Environment:**
- Variables defined in `.env` (see `.env.example` for template)
- Frontend variables require `VITE_` prefix
- Key frontend vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_URL`
- Server-only vars: `SUPABASE_SERVICE_ROLE_KEY`, `XPEED_OAUTH_JWT_SECRET`
- Admin credentials (scripts only): `ADMIN_EMAIL`, `ADMIN_PASSWORD`
- AI key: stored in DB (`app_settings` table) — no env var required in production

**Build:**
- `vite.config.ts` - Main build config with chunking strategy and PWA manifest
- `tsconfig.json` - Root config (references `tsconfig.app.json`, `tsconfig.node.json`)
- `tsconfig.app.json` - App compile options (strict=false, ES2020, bundler moduleResolution, `@/*` path alias)
- `tailwind.config.ts` - Tailwind configuration
- `postcss.config.js` - PostCSS with autoprefixer
- `eslint.config.js` - ESLint 9 flat config with typescript-eslint
- `components.json` - shadcn/ui configuration (style: default, baseColor: slate, cssVariables: true)

## Platform Requirements

**Development:**
- Node.js 20+ (scripts, CI)
- Bun (preferred for installs)
- Supabase CLI (`supabase` devDependency ^2.76.6) for local Edge Function development

**Production:**
- Vercel - SPA hosting + Edge Functions under `api/`
- Supabase (project ID: `drqmrddxlrlbqnydumjm`) - Database (PostgreSQL), Auth, Storage, Edge Functions
- GitHub Actions - CI/CD keepalive cron every 6 hours (`.github/workflows/supabase-keepalive.yml`)

---

*Stack analysis: 2026-05-29*
