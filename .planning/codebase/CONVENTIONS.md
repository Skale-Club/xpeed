# Coding Conventions

**Analysis Date:** 2026-05-15

## Naming Patterns

**Files:**
- React components: PascalCase with `.tsx` extension (e.g., `AIAnalysisCard.tsx`, `PageLoader.tsx`, `PrivateRoute.tsx`)
- Custom hooks: kebab-case with `use-` prefix and `.ts` extension (e.g., `use-cars.ts`, `use-csv-upload.ts`, `use-toast.ts`)
- Utility/library files: camelCase with `.ts` extension (e.g., `csv-parser.ts`, `gemini-service.ts`, `insight-engine.ts`)
- Context providers: PascalCase with `.tsx` extension (e.g., `AuthContext.tsx`, `CarsContext.tsx`)
- UI components (shadcn): kebab-case (e.g., `button.tsx`, `card.tsx`, `dialog.tsx`)

**Functions:**
- Regular functions and hooks: camelCase (e.g., `parseCSV`, `detectDelimiter`, `createSession`)
- Component functions: PascalCase (e.g., `export default function PrivateRoute`, `export function ChatBubble`)
- Event handlers: camelCase with `handle` prefix (e.g., `onClick={() => setIsOpen(!isOpen)}`)
- Callback functions: camelCase with `on` prefix or clear verb names (e.g., `onComplete`, `onClose`, `updateProgress`)

**Variables:**
- Component props: camelCase (e.g., `isOpen`, `className`, `carProfileId`)
- Local state: camelCase (e.g., `uploading`, `progressLabel`, `selectedCarId`)
- Constants: UPPER_SNAKE_CASE (e.g., `STORAGE_KEY`, `DEFAULT_PRIUS_RULES`, `tsKeywords`)
- Type/Interface names: PascalCase (e.g., `AIAnalysisCardProps`, `ParsedCSV`, `AuthContextType`)

**Types:**
- Interface names: PascalCase ending in appropriate suffix (e.g., `PrivateRouteProps`, `AIAnalysisCardProps`, `SettingsContextType`)
- Utility types: PascalCase (e.g., `CarProfile`, `ChatMessage`, `ChatConversation`)
- Discriminated union fields: camelCase (e.g., `type: 'timestamp' | 'seconds' | 'index'`)

## Code Style

**Formatting:**
- No Prettier config detected. Use ESLint's built-in defaults.
- Quote style: Single quotes for string literals in `.tsx`/`.ts` files (see: `src/components/ChatBubble.tsx`, `src/hooks/use-cars.ts`)
- Double quotes used in certain template configs (e.g., `App.tsx`)
- Indentation: 2 spaces (standard for React projects)
- Semicolons: Consistently used at end of statements

**Linting:**
- ESLint 9.32.0 with typescript-eslint 8.38.0
- Config: `eslint.config.js` (flat config format)
- Key rules enforced:
  - `@typescript-eslint/no-unused-vars`: off (disabled to allow experimentation)
  - `react-refresh/only-export-components`: warn (allows component exports with constants)
  - `react-hooks/recommended`: enabled (enforces Hook rules)
- Target: ES2020, JSX: react-jsx

## Import Organization

**Order:**
1. React and external libraries (e.g., `import React, { Suspense, lazy } from "react"`)
2. Third-party packages (e.g., `import { useAuth } from '@/contexts/AuthContext'`)
3. Internal absolute imports from `@/` path alias
4. Internal relative imports (rare; mostly uses `@/`)

**Path Aliases:**
- `@/*` maps to `./src/*` (configured in both `tsconfig.json` and `vitest.config.ts`)
- Always use `@/` for imports within src: `@/components`, `@/hooks`, `@/lib`, `@/contexts`, `@/integrations`
- Example: `import { parseCSV } from '@/lib/csv-parser'` (see `src/hooks/use-csv-upload.ts`)

**Import Structure Examples:**

From `src/components/AppLayout.tsx`:
```typescript
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Upload, BarChart3, ... } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { Button } from '@/components/ui/button';
```

From `src/hooks/use-csv-upload.ts`:
```typescript
import { useState, useCallback } from 'react';
import { parseCSV } from '@/lib/csv-parser';
import { computeParameterSummaries, evaluateRules } from '@/lib/insight-engine';
import { useToast } from '@/hooks/use-toast';
```

## Error Handling

**Patterns:**
- Try-catch with explicit error type checking (see `src/hooks/use-csv-upload.ts:194-209`)
- Error conversion: `err instanceof Error ? err.message : 'Fallback message'` (used in `src/hooks/use-cars.ts`)
- Toast notifications for user-facing errors: `toast({ title: 'Error', description: String(err), variant: 'destructive' })`
- Console logging for non-critical warnings: `console.warn()` for expected failures (storage, AI analysis)
- Console logging for critical errors: `console.error()` for unexpected issues

**Error Recovery:**
- Rollback pattern used in CSV upload (cleanup session or file if upload fails)
- Try-finally pattern to ensure cleanup: state reset happens in finally block (see `use-csv-upload.ts:212-215`)
- Optional features fail gracefully: AI analysis failure doesn't block upload completion (see `use-csv-upload.ts:186-189`)

## Logging

**Framework:** console (native browser console)

**Patterns:**
- `console.error()`: Critical errors that interrupt flow (see `src/hooks/use-csv-upload.ts:195`)
- `console.warn()`: Non-blocking failures like storage unavailability or optional AI analysis (see `src/lib/db.ts`, `AuthContext.tsx:60`)
- Structured logging: Include operation context (e.g., "Storage upload unavailable, keeping CSV in database only")
- No debug logs in components; only in utility functions when operations might fail

## Comments

**When to Comment:**
- Explain "why" not "what" (e.g., "Only show loader if loading takes more than 150ms to avoid flicker" in `PageLoader.tsx:14`)
- Document non-obvious logic steps (e.g., time detection priority in `csv-parser.ts:59`)
- Explain workarounds or temporary solutions (prefixed with comments like "Priority 1", "Priority 2")
- Document state changes that affect behavior (e.g., "Auto-select first car if none selected" in `use-cars.ts:33`)

**JSDoc/TSDoc:**
- Light usage; primarily on interfaces and types
- Function documentation minimal unless behavior is non-obvious
- Example from `src/contexts/AuthContext.tsx`: Interface types are documented inline
- Return type comments rare; signatures are self-documenting via TypeScript

**Comment Examples:**

From `src/components/PageLoader.tsx`:
```typescript
// Only show loader if loading takes more than 150ms to avoid flicker
const timer = setTimeout(() => setShow(true), 150);
```

From `src/hooks/use-cars.ts`:
```typescript
// Auto-select first car if none selected or if selected car is not in the list (e.g. filtered out)
```

From `src/lib/csv-parser.ts`:
```typescript
// Priority 1: timestamp/date/time column with ISO-like values
// Priority 2: numeric time column
```

## Function Design

**Size:**
- Typical hook functions: 50-120 lines (e.g., `use-csv-upload.ts` at 221 lines is larger due to async multi-step process)
- Component functions: 20-50 lines (e.g., `ChatBubble.tsx` at 31 lines, `PrivateRoute.tsx` at 28 lines)
- Utility functions: 10-40 lines (e.g., `detectDelimiter` at 4 lines, `parseCSVLine` at 26 lines)

**Parameters:**
- Prefer object destructuring for multiple related params (e.g., `{ children }: { children: React.ReactNode }`)
- Single params often used directly (e.g., `file: File`, `query: string`)
- Optional params use `?` and default values (e.g., `customName?: string`, `className?: string`)
- Callbacks passed as params with `on`/`handle` prefix (e.g., `onComplete: (sessionId: string) => void`)

**Return Values:**
- Functions return typed objects for multiple outputs (e.g., `use-csv-upload` returns `{ upload, uploading, progressLabel, progressValue }`)
- Hooks return consistent object shapes
- Async functions return `Promise<T>` with explicit type
- Components return JSX.Element implicitly (no explicit return type)

**Async Patterns:**
```typescript
// From use-csv-upload.ts: Use async/await with proper error handling
const upload = useCallback(async (file: File, customName?: string) => {
  try {
    updateProgress(6, 'Reading file...');
    const text = await file.text();
    // ... more operations with updateProgress calls
  } catch (err) {
    // Handle error
  } finally {
    setUploading(false);
  }
}, [carProfileId, onComplete, toast, updateProgress]);
```

## Module Design

**Exports:**
- Named exports for utilities and hooks (e.g., `export function parseCSV()`, `export function useCSVUpload()`)
- Default exports for components (e.g., `export default function PrivateRoute()`)
- Mixed pattern in contexts: default export for Provider, named export for hook (see `AuthContext.tsx`)

**Barrel Files:**
- Not used extensively; direct imports from source files preferred
- Keep imports specific: `import { parseCSV } from '@/lib/csv-parser'` not generic path imports

**Type Exports:**
- Export types alongside implementations (e.g., `type ParsedCSV`, `type AuthContextType`)
- Use `type` keyword for type-only imports: `import type { User, Session } from '@supabase/supabase-js'`

**Re-exports Pattern:**
- Minimal re-exporting; each module has single responsibility
- Exceptions: Context files export both Provider and hook from same file

---

*Convention analysis: 2026-05-15*
