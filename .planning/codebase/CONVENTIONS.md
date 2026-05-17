# Coding Conventions

**Analysis Date:** 2026-05-17

## Naming Patterns

**Files:**
- React page components: PascalCase — `CarsPage.tsx`, `HistoryPage.tsx`, `SessionDetail.tsx`
- React shared components: PascalCase — `FlagsPanel.tsx`, `AppLayout.tsx`, `ChatContainer.tsx`
- Custom hooks: kebab-case with `use-` prefix — `use-cars.ts`, `use-csv-upload.ts`, `use-toast.ts`
- Library/utility modules: kebab-case — `csv-parser.ts`, `insight-engine.ts`, `default-rules.ts`, `canonical-params.ts`
- Context files: PascalCase with `Context` suffix — `CarsContext.tsx`, `AuthContext.tsx`, `SettingsContext.tsx`
- Supabase DB layer: flat name `db.ts`, with chat-specific layer at `src/lib/chat/db.ts`
- Type definition files: descriptive noun — `src/lib/chat/types.ts`

**Functions:**
- Component event handlers: `handle` prefix — `handleCreateCar`, `handleDeleteCar`, `handleUpdateCar`, `handleSendMessage`
- Hook-exported operations: camelCase verb-noun — `createCar`, `updateCar`, `deleteCar`, `selectCar`, `refresh`
- DB layer exports: camelCase verb-noun — `getUserCars`, `createCarProfile`, `uploadSessionCSV`, `insertSessionFlags`
- Pure utility exports: camelCase verb-noun — `parseCSV`, `evaluateRules`, `computeParameterSummaries`, `matchCanonicalKey`
- Internal helpers: camelCase, unexported — `detectDelimiter`, `parseCSVLine`, `estimateSampleInterval`, `extractMessage`, `isNumeric`
- Context hook exports: `use` prefix matching context — `useCarsContext`, `useAuth`

**Variables:**
- State variables: camelCase — `selectedCarId`, `newCarName`, `progressValue`, `uploading`
- Boolean loading state on hooks: no prefix — `loading`, `uploading`
- Boolean UI state in components: `is` prefix — `isCreating`, `isUpdating`, `isDeleting`, `isAddDialogOpen`
- Module-level constants: SCREAMING_SNAKE_CASE — `DEFAULT_PRIUS_RULES`, `CANONICAL_PARAMS`, `PRIUS_PRIORITY_KEYS`, `SESSION_CSV_BUCKET`, `SESSION_LIST_SELECT`, `STORAGE_KEY`

**Types and Interfaces:**
- PascalCase throughout — `CarProfile`, `ParsedCSV`, `SessionFlag`, `FlagEvidence`, `ChatMessage`, `ChatConversation`
- `interface` preferred over `type` for object shapes
- Props interfaces named `[ComponentName]Props` — `FlagsPanelProps`, `ChatContainerProps`
- Context type interfaces named `[Name]ContextType` — `CarsContextType`, `AuthContextType`
- Exported interfaces for cross-module data contracts; unexported interfaces for internal shapes (e.g., `Rule` in `src/lib/insight-engine.ts`)

## Code Style

**Formatting:**
- No Prettier config file — formatting is not enforced by tooling; rely on editor defaults
- Indentation: 2 spaces (consistently observed)
- Semicolons: present at end of statements
- Quotes: single quotes in `.ts` files; double quotes in some JSX attribute strings
- Trailing commas: used in multi-line object/array literals

**Linting:**
- ESLint 9 flat config at `eslint.config.js`
- Extends `js.configs.recommended` + `typescript-eslint.configs.recommended`
- Plugins: `eslint-plugin-react-hooks` (recommended rules), `eslint-plugin-react-refresh`
- `@typescript-eslint/no-unused-vars`: **disabled** — unused variables are not flagged
- `react-refresh/only-export-components`: warn (allows constant exports alongside components)
- No import order rule enforced

## Import Organization

**Observed order (not linter-enforced):**
1. React primitives — `import { useState, useEffect } from 'react'`
2. Third-party routing/utility libraries — `react-router-dom`, `lucide-react`, `@google/generative-ai`
3. Shadcn/ui primitives — `@/components/ui/card`, `@/components/ui/button`
4. Internal shared components — `@/components/AppLayout`, `@/components/PageLoader`
5. Contexts — `@/contexts/CarsContext`, `@/contexts/AuthContext`
6. Hooks — `@/hooks/use-toast`, `@/hooks/use-cars`
7. Library/utility modules — `@/lib/db`, `@/lib/csv-parser`, `@/lib/gemini-service`
8. Type-only imports — `import type { CarProfile } from '@/lib/db'`

**Path Aliases:**
- `@/` maps to `src/` — configured in `vitest.config.ts` and Vite config
- Used exclusively throughout — no `../` relative traversal across directories
- Example: `import { parseCSV } from '@/lib/csv-parser'`

## Error Handling

**Strategy:** Library functions throw; hooks catch + re-throw; components catch + toast.

**DB layer pattern (`src/lib/db.ts`):**
```typescript
export async function getUserCars(): Promise<CarProfile[]> {
  const { data, error } = await supabase.from('car_profiles').select('*')...;
  if (error) {
    throw new Error(`Failed to fetch cars: ${error.message}`);
  }
  return data || [];
}
```

**Hook pattern (`src/hooks/use-cars.ts`):**
```typescript
const createCar = useCallback(async (name: string, notes?: string) => {
  try {
    setError(null);
    const newCar = await createCarProfile(name, notes);
    setCars(prev => [newCar, ...prev]);
    return newCar;
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to create car');
    throw err; // re-throw so page handler can also respond
  }
}, []);
```

**Component pattern (`src/pages/CarsPage.tsx`):**
```typescript
try {
  await createCar(newCarName.trim(), newCarNotes.trim() || undefined);
  toast({ title: 'Success', description: 'Car added successfully' });
} catch (error) {
  toast({ title: 'Error', description: String(error), variant: 'destructive' });
}
```

**Rollback pattern** used in `src/hooks/use-csv-upload.ts` — on upload failure, orphaned session or storage file is cleaned up in the catch block.

**Optional subsystems** isolated with their own try/catch and `console.warn` so they don't propagate to the parent: Gemini AI analysis during upload is an example.

## Logging

**Framework:** `console.*` only — no structured logging library

**Patterns:**
- `console.error('Context:', error)` — unexpected failures that interrupt flow (DB errors, Gemini API errors)
- `console.warn('Context:', error)` — recoverable/non-critical failures (storage unavailable, AI analysis failed)
- No log IDs, no structured metadata, no log levels beyond these two tiers

## Comments

**When to Comment:**
- Section dividers within long files: `// Car management functions`, `// AI Settings`, `// Chat Database Operations`
- Non-obvious priority logic: `// Priority 1: timestamp/date/time column...`, `// Priority 2: numeric time column`
- State management intent: `// Auto-select first car if none selected or if selected car is not in the list`
- Temporary workarounds: `// TODO: Update types when column is official` (`src/lib/db.ts:279`)

**JSDoc/TSDoc:**
- Used selectively in `src/lib/gemini-service.ts` only — all exported functions have `/** */` block comments
- Not used in components, hooks, or DB layer

## TypeScript Conventions

**Type assertions (systemic patterns to be aware of):**
- `as unknown as never` — used in all Supabase insert calls for JSON column types: `columns as unknown as never`, `summary as unknown as never`, `data as unknown as never` (across `src/lib/db.ts`)
- `as any` — used where `session.summary` JSON shape is not narrowed: `src/pages/HistoryPage.tsx:150`, `src/pages/SessionDetail.tsx:51`, `src/lib/db.ts:279`
- `as unknown as Record<string, unknown>` — used for evidence/analysis types at module boundaries
- `@ts-ignore` — single occurrence in `src/pages/SettingsPage.tsx:32` for `Intl.supportedValuesOf`

**Non-null assertions:**
- `data!` used after successful Supabase `.single()` on insert — assumes no error occurred
- Pattern: `const { data } = await supabase.from('x').insert({}).select().single(); return data!;`

**Optional vs union:**
- `param?: string` preferred over `param: string | undefined` for function parameters
- `string | null` used for nullable database fields

**Type imports:**
- `import type { ... }` used for type-only imports from Supabase — `import type { User, Session } from '@supabase/supabase-js'`

## Module Design

**Exports:**
- Default export for React components — `export default function FlagsPanel(...)`
- Named exports for hooks, utility functions, types, context providers
- Context files export both Provider (default or named) and the consumer hook from the same file

**Barrel files:**
- Not used — import directly from source files
- `src/components/ui/` has individual files, not an index re-export

**Single responsibility:**
- `src/lib/db.ts` — all Supabase data access (sessions, cars, flags, settings, storage)
- `src/lib/chat/db.ts` — chat-specific Supabase operations
- `src/lib/csv-parser.ts` — CSV parsing only
- `src/lib/insight-engine.ts` — rule evaluation only
- `src/lib/gemini-service.ts` — Gemini API calls only
- `src/lib/canonical-params.ts` — OBD2 parameter definitions and matching

---

*Convention analysis: 2026-05-17*
