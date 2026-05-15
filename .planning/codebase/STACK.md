# Technology Stack

**Analysis Date:** 2026-05-15

## Languages

**Primary:**
- TypeScript 5.8.3 - Used across all source code (`src/**/*.ts`, `src/**/*.tsx`)
- JavaScript (Node.js) - Build scripts and configuration files

**Secondary:**
- CSS/Tailwind - Styling throughout the application
- TOML - Supabase configuration in `supabase/config.toml`

## Runtime

**Environment:**
- Node.js (version not specified in package.json or .nvmrc)
- Browser (Modern browsers with ES2020 support)

**Package Manager:**
- npm (with package-lock.json present)
- Lockfile: package-lock.json exists

## Frameworks

**Core:**
- React 18.3.1 - UI framework (`src/App.tsx`, `src/pages/**`, `src/components/**`)
- React Router DOM 6.30.1 - Client-side routing (`src/App.tsx`, page components)

**UI Component System:**
- Radix UI (multiple packages) - Accessible component primitives (@radix-ui/react-*)
  - Components: accordion, alert-dialog, avatar, checkbox, dialog, dropdown-menu, etc.
  - Located in `src/components/ui/` (auto-generated shadcn/ui components)

**AI & Chat:**
- @ai-sdk/react 3.0.118 - AI SDK for React (chat integrations)
- @google/generative-ai 0.24.1 - Google Gemini API client (`src/lib/gemini-service.ts`)

**Data Management:**
- @tanstack/react-query 5.83.0 - Server state management (API caching)
- @supabase/supabase-js 2.95.3 - Supabase client for database/auth (`src/integrations/supabase/client.ts`)

**Forms & Validation:**
- React Hook Form 7.61.1 - Form state management (`src/components/**`, pages)
- @hookform/resolvers 3.10.0 - Form validation resolvers
- Zod 3.25.76 - TypeScript-first schema validation

**Styling:**
- Tailwind CSS 3.4.17 - Utility-first CSS framework (`tailwind.config.ts`)
- Class Variance Authority 0.7.1 - Type-safe CSS class composition
- Tailwind Merge 2.6.0 - Merge conflicting Tailwind classes
- tailwindcss-animate 1.0.7 - Animation utilities
- PostCSS 8.5.6 - CSS processing
- Autoprefixer 10.4.21 - Vendor prefix automation

**Charts & Visualization:**
- Recharts 2.15.4 - React chart library (`src/components/DashboardCharts.tsx`, `src/components/SessionCharts.tsx`)

**UI Utilities:**
- Lucide React 0.462.0 - SVG icon library
- Sonner 1.7.4 - Toast notifications
- React Markdown 10.1.0 - Markdown rendering
- Embla Carousel React 8.6.0 - Carousel component
- React Resizable Panels 2.1.9 - Resizable panel layout
- Vaul 0.9.9 - Drawer component
- Date-fns 3.6.0 - Date manipulation
- Next Themes 0.3.0 - Theme management (dark mode)
- CLSX 2.1.1 - Conditional className utility
- Input OTP 1.4.2 - OTP input component

**Testing:**
- Vitest 3.2.4 - Unit testing framework (configured in `vitest.config.ts`)
- @testing-library/react 16.0.0 - React component testing
- @testing-library/jest-dom 6.6.0 - DOM matchers
- JSDOM 20.0.3 - DOM environment for tests

**Build & Development:**
- Vite 5.4.19 - Build tool and dev server (`vite.config.ts`)
- @vitejs/plugin-react-swc 3.11.0 - React plugin using SWC compiler
- TypeScript 5.8.3 - Type checking

**Code Quality:**
- ESLint 9.32.0 - JavaScript/TypeScript linting (`eslint.config.js`)
  - @eslint/js 9.32.0 - ESLint core rules
  - typescript-eslint 8.38.0 - TypeScript linting support
  - eslint-plugin-react-hooks 5.2.0 - React hooks linting
  - eslint-plugin-react-refresh 0.4.20 - React refresh linting
- dotenv 17.2.4 - Environment variable loading

**Infrastructure & Monitoring:**
- @vercel/analytics 1.6.1 - Vercel analytics integration (`src/App.tsx`)

**Database & Supabase:**
- supabase CLI 2.76.6 (dev dependency) - Supabase project management

## Key Dependencies

**Critical:**
- @supabase/supabase-js 2.95.3 - Backend-as-a-service platform for database, auth, and file storage (`src/integrations/supabase/client.ts`)
- @google/generative-ai 0.24.1 - Google Gemini LLM for AI analysis (`src/lib/gemini-service.ts`)
- React 18.3.1 - Core UI rendering

**Infrastructure:**
- Vite 5.4.19 - Zero-config build tool with hot module replacement
- TypeScript 5.8.3 - Static type checking
- Vitest 3.2.4 - Fast unit testing

**State Management:**
- @tanstack/react-query 5.83.0 - Server state synchronization
- React Router DOM 6.30.1 - Client-side navigation

## Configuration

**Environment:**
- Environment variables loaded via `import.meta.env` (Vite convention)
- Critical env vars defined in `.env.example`:
  - `VITE_SUPABASE_URL` - Supabase project URL
  - `VITE_SUPABASE_PUBLISHABLE_KEY` - Supabase public key
  - `VITE_SUPABASE_PROJECT_ID` - Supabase project ID
  - `VITE_APP_URL` - Application URL (for OAuth redirects)
  - `SUPABASE_SERVICE_ROLE_KEY` - Server-side Supabase operations
  - `VITE_ADMIN_EMAIL` / `VITE_ADMIN_PASSWORD` - Admin credentials (client-side)
  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` - Admin credentials (Node.js scripts)

**Build:**
- `vite.config.ts` - Vite configuration with path alias `@` → `./src`
- `tsconfig.json` - TypeScript base config
- `tsconfig.app.json` - App-specific TypeScript config
- `tsconfig.node.json` - Build script TypeScript config
- `tailwind.config.ts` - Tailwind CSS configuration with custom colors and animations
- `postcss.config.js` - PostCSS configuration
- `components.json` - Shadcn/UI configuration
- `eslint.config.js` - ESLint configuration

## Platform Requirements

**Development:**
- Node.js runtime
- npm or compatible package manager
- Modern terminal/shell
- Browser with ES2020 support

**Production:**
- Vercel (indicated by `vercel.json` rewrites configuration)
- Supabase hosted backend
- Google Gemini API key (for AI features)
- Deployed as SPA (Single Page Application) with client-side routing

---

*Stack analysis: 2026-05-15*
