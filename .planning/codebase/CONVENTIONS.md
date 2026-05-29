# Coding Conventions

**Analysis Date:** 2026-05-29

## Naming Patterns

**Files:**
- React components: PascalCase `.tsx` — `AppLayout.tsx`, `AddVehicleForm.tsx`, `DTCPanel.tsx`
- Pages: PascalCase `.tsx` ending in `Page` or descriptive noun — `LoginPage.tsx`, `SessionDetail.tsx`, `SharedReport.tsx`
- Hooks: kebab-case `.ts` prefixed with `use-` — `use-cars.ts`, `use-admin-status.ts`, `use-csv-upload.ts`
- Library/utility modules: kebab-case `.ts` — `csv-parser.ts`, `vin-decoder.ts`, `insight-engine.ts`
- Context files: PascalCase `.tsx` ending in `Context` — `AuthContext.tsx`, `CarsContext.tsx`
- Type definition files: singular noun `.ts` — `session.ts`
- Sub-directories of components: lowercase — `src/components/ui/`, `src/components/chat/`, `src/components/admin/`

**Functions:**
- React components: PascalCase — `export default function LoginPage()`, `export function AppSidebar()`
- Hooks: camelCase prefixed with `use` — `useCars()`, `useAuth()`, `useSettings()`
- Event handlers: camelCase prefixed with `handle` — `handleSubmit`, `handleDecodeVin`, `handleGoogleSignIn`
- Async data-fetching utilities: camelCase verb phrases — `getSessions()`, `createCarProfile()`, `deleteCarProfile()`
- Context consumer hooks: camelCase — `useAuth()`, `useSettings()`, `useCarsContext()`

**Variables:**
- camelCase throughout — `selectedCarId`, `trimmedMake`, `googleLoading`
- Boolean state: present-tense descriptive — `loading`, `creating`, `decoding`, `isAdmin`, `isInstalled`
- Constant arrays/objects in components: SCREAMING_SNAKE_CASE — `ENGINE_TYPES`, `SESSION_CSV_BUCKET`, `SESSION_LIST_SELECT`
- localStorage keys: lowercase with underscores — `'selected_car_id'`, `'settings_distanceUnit'`, `'settings_timezone'`

**Types/Interfaces:**
- `interface` for object shapes — `AddVehicleFormProps`, `AuthContextType`, `SettingRowState`
- `type` for unions and aliases — `SessionSeverity`, `DistanceUnit`, `CarProfileInput`
- Props interfaces: PascalCase component name + `Props` suffix — `DTCPanelProps`, `HealthGaugeProps`
- Context types: PascalCase ending in `ContextType` — `AuthContextType`, `SettingsContextType`

## Code Style

**Formatting:**
- No Prettier config detected — formatting is not enforced by tooling
- Indentation: 2 spaces (observed consistently)
- Trailing commas present in multi-line structures
- Single quotes for imports in most files; some files use double quotes (mixed, no enforced rule)

**Linting:**
- ESLint via `eslint.config.js` using flat config format
- Extends: `@eslint/js` recommended + `typescript-eslint` recommended
- Plugins: `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`
- `react-hooks/recommended` rules enforced
- `@typescript-eslint/no-unused-vars` is turned **off** — unused variables are not flagged
- `react-refresh/only-export-components` set to warn (allows constant exports)

## TypeScript Strictness

**Settings** (`tsconfig.app.json`):
- `strict: false` — strict mode is disabled
- `noImplicitAny: false` — implicit `any` is allowed
- `noUnusedLocals: false` — unused locals not checked
- `noUnusedParameters: false` — unused parameters not checked
- `noFallthroughCasesInSwitch: false` — switch fallthrough not checked
- Target: `ES2020`, module: `ESNext` bundler mode

**Practical implications:**
- Type assertions and `any` types appear without compiler errors
- Functions can omit return type annotations
- Optional chaining `?.` and nullish coalescing `??` used throughout

## Import Organization

**Path Aliases:**
- `@/*` maps to `./src/*` — configured in both `vite.config.ts` and `tsconfig.app.json`
- Use `@/` for all internal imports; relative paths are not used

**Order (observed pattern — not enforced by linter):**
1. React and React ecosystem (`react`, `react-dom`, `react-router-dom`)
2. Third-party libraries (`@tanstack/react-query`, `lucide-react`, etc.)
3. Internal contexts via `@/contexts/`
4. Internal hooks via `@/hooks/`
5. Internal lib utilities via `@/lib/`
6. Internal components via `@/components/`
7. Types via `@/types/`

**Example:**
```typescript
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
```

## Error Handling

**Patterns:**
- `try/catch` blocks in all async operations — errors caught and surfaced via `toast()`
- Error messages: `error instanceof Error ? error.message : String(error)` — consistent pattern
- Auth errors: thrown from context methods, caught at call site
- DB functions in `src/lib/db.ts`: throw errors directly; callers wrap in try/catch
- Non-critical failures (AI analysis, storage upload): logged with `console.warn()` and silently skipped
- Critical failures: surfaced via `toast({ variant: 'destructive' })` or local `setError()` state

**Toast usage for errors:**
```typescript
toast({
  title: 'Could not register vehicle',
  description: error instanceof Error ? error.message : String(error),
  variant: 'destructive',
});
```

**Local error state for forms:**
```typescript
const [error, setError] = useState('');
// then in handler:
setError(err instanceof Error ? err.message : 'Failed to sign in');
```

## Logging

**Framework:** `console.*` — no structured logging library

**Patterns:**
- `console.error()` for unexpected failures in event handlers and page-level effects
- `console.warn()` for non-fatal degraded paths (AI skipped, storage unavailable)
- No `console.log()` for debug output in source files (clean production code)
- Log format: short string prefix + error value — `console.error('Failed to rename session:', error)`

## Form Handling

**Approach:**
- Forms primarily use **controlled `useState`** — individual `useState` for each field (see `src/components/AddVehicleForm.tsx`, `src/pages/LoginPage.tsx`)
- `react-hook-form` is installed and `src/components/ui/form.tsx` wraps it (shadcn form primitives), but forms in the app do NOT currently use `useForm` with Zod schemas
- Validation is manual: inline checks before submit, toast on failure
- `zod` is installed as a dependency but not actively used for form schemas in the current codebase

**Manual validation pattern:**
```typescript
if (!trimmedYear || !trimmedMake || !trimmedModel) {
  toast({ title: 'Missing fields', description: 'Year, make, and model are required.', variant: 'destructive' });
  return;
}
```

## Comments

**When to Comment:**
- Inline comments explain non-obvious decisions — `// Scope the lookup to the authenticated user`
- Section comments in long files — `// Lazy imports`, `// Public Routes`, `// Protected Routes`
- Warning comments on generated files — `// This file is automatically generated. Do not edit it directly.`

**JSDoc/TSDoc:**
- Not used — no JSDoc annotations observed in source files

## Component Design

**Structure:**
- Props interface defined at top of file before component
- Named exports (`export function`) for reusable components
- Default exports (`export default function`) for pages and some layout components
- No barrel `index.ts` files — import directly from full file path

**Props pattern:**
```typescript
interface AddVehicleFormProps {
  onSuccess: (carId: string) => void;
  onCancel: () => void;
}

export function AddVehicleForm({ onSuccess, onCancel }: AddVehicleFormProps) {
```

**Children prop:**
```typescript
export default function AppLayout({ children }: { children: React.ReactNode }) {
```

## Context Pattern

Contexts use the provider + hook pattern consistently across all three contexts in `src/contexts/`:

```typescript
const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) { ... }

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
```

Guard clause throws if hook is used outside provider — enforced in all contexts (`AuthContext.tsx`, `CarsContext.tsx`, `SettingsContext.tsx`).

## Module Design

**Exports:**
- One primary export per file (component/function/hook)
- Additional named exports for related types or constants in same file
- No barrel files (`index.ts`) — imports use full file paths

**UI Components:**
- `src/components/ui/` contains shadcn/ui components — treat as read-only generated code
- Application components in `src/components/` follow the same patterns but are writable

## Styling

**Approach:** Tailwind CSS utility classes exclusively — no CSS modules, no inline `style` props
- `cn()` utility from `src/lib/utils.ts` used for conditional class merging (`clsx` + `tailwind-merge`)
- Design tokens via CSS variables (`bg-background`, `text-foreground`, `border-border`, `text-muted-foreground`)
- Dark mode via `next-themes` provider and Tailwind's CSS variable system
- `font-mono` used for technical/code-like labels and data values

```typescript
import { cn } from "@/lib/utils";

className={cn("px-3 py-1 rounded-full text-xs font-mono border", isActive && "bg-primary")}
```

---

*Convention analysis: 2026-05-29*
