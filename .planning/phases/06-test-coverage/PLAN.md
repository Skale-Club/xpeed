---
phase: 06-test-coverage
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - src/test/utils/supabase-mock.ts
  - src/test/utils/render.tsx
  - src/test/fixtures/sample.csv
  - src/test/fixtures/sessions.ts
  - src/test/csv-parser.test.ts
  - src/test/canonical-params.test.ts
  - src/test/insight-engine.test.ts
  - src/test/use-cars.test.ts
  - src/test/auth-context.test.tsx
  - src/test/cars-page.test.tsx
  - src/test/flags-panel.test.tsx
  - src/test/csv-upload-flow.test.ts
autonomous: true
requirements:
  - TEST-01
  - TEST-02
  - TEST-03
  - TEST-04
  - TEST-05
  - TEST-06
  - TEST-07
  - TEST-08
  - TEST-09

must_haves:
  truths:
    - "`npm test` passes with zero failures across all new test files"
    - "`npm run test:coverage` reports >= 70% line coverage on `src/lib/`"
    - "CSV parser correctly rejects empty files and malformed input — verified by unit tests"
    - "Insight engine produces `critical` flag when value sustains above threshold — verified by unit tests"
    - "Auth context transitions from loading=true to loading=false after session resolution"
    - "useCars auto-selects the first car after load, and switches selection after deletion"
    - "CarsPage renders the empty-state card when the cars list is empty"
    - "FlagsPanel renders the green no-flags card when flags=[]"
    - "Integration test: sample CSV → parse → evaluateRules → >= 1 flag produced"
  artifacts:
    - path: "src/test/utils/supabase-mock.ts"
      provides: "Reusable vi.fn() Supabase client mock (auth + from chain)"
    - path: "src/test/utils/render.tsx"
      provides: "Custom render() wrapping AuthProvider, CarsProvider, and React Query"
    - path: "src/test/fixtures/sample.csv"
      provides: "Minimal valid OBD2 CSV with coolant_temp and engine_rpm columns"
    - path: "src/test/fixtures/sessions.ts"
      provides: "Typed CarProfile and SessionFlag fixture factories"
    - path: "src/test/csv-parser.test.ts"
      provides: "Unit tests for parseCSV — 6+ cases"
    - path: "src/test/canonical-params.test.ts"
      provides: "Unit tests for matchCanonicalKey — 4+ cases"
    - path: "src/test/insight-engine.test.ts"
      provides: "Unit tests for evaluateRules — 4+ cases"
    - path: "src/test/use-cars.test.ts"
      provides: "Hook tests via renderHook — 4+ cases"
    - path: "src/test/auth-context.test.tsx"
      provides: "AuthProvider behavior tests — 4+ cases"
    - path: "src/test/cars-page.test.tsx"
      provides: "CarsPage component render tests — 3+ cases"
    - path: "src/test/flags-panel.test.tsx"
      provides: "FlagsPanel render tests — 3+ cases"
    - path: "src/test/csv-upload-flow.test.ts"
      provides: "End-to-end integration test for parse → flag pipeline"
  key_links:
    - from: "src/test/use-cars.test.ts"
      to: "src/test/utils/supabase-mock.ts"
      via: "vi.mock('@/integrations/supabase/client', () => ({ supabase: createSupabaseMock() }))"
      pattern: "vi\\.mock.*supabase.*client"
    - from: "src/test/auth-context.test.tsx"
      to: "src/test/utils/supabase-mock.ts"
      via: "same supabase vi.mock pattern"
      pattern: "vi\\.mock.*supabase.*client"
    - from: "src/test/cars-page.test.tsx"
      to: "src/test/utils/render.tsx"
      via: "custom render() provides CarsContext and AuthContext"
      pattern: "import.*render.*from.*utils/render"
    - from: "src/test/csv-upload-flow.test.ts"
      to: "src/lib/csv-parser.ts + src/lib/insight-engine.ts"
      via: "direct import, no mocking of parser/engine"
      pattern: "import.*parseCSV.*import.*evaluateRules"
---

<objective>
Achieve meaningful automated test coverage for all critical paths in car-insights-ai: the pure-function lib layer (csv-parser, insight-engine, canonical-params), stateful hooks (useCars), React context (AuthContext), UI components (CarsPage, FlagsPanel), and the end-to-end CSV-to-flags integration pipeline.

Purpose: The application currently has one trivial placeholder test. Any regression in parsing, flag generation, or auth state is invisible. This plan establishes a test foundation that catches regressions before they reach production and documents the expected behavior of every critical path.

Output:
- 13 new files (test utilities, fixtures, and test suites)
- `@vitest/coverage-v8` added as devDependency
- `test:coverage` script in package.json
- >= 70% line coverage on `src/lib/`
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md

<!-- Key source files under test — read before writing tests to match real API shapes -->
@src/lib/csv-parser.ts
@src/lib/insight-engine.ts
@src/lib/canonical-params.ts
@src/hooks/use-cars.ts
@src/contexts/AuthContext.tsx
@src/contexts/CarsContext.tsx
@src/pages/CarsPage.tsx
@src/components/FlagsPanel.tsx
@src/integrations/supabase/client.ts
@vitest.config.ts
@src/test/setup.ts
</context>

<interfaces>
<!-- Interfaces extracted from source files. Use these directly — no exploration needed. -->

From src/lib/csv-parser.ts:
```typescript
export interface ParsedCSV {
  headers: string[];
  rows: Record<string, number | string | null>[];
  headerMapping: Record<string, { canonical_key: string; label: string; unit: string } | null>;
  timeColumn: { type: 'timestamp' | 'seconds' | 'index'; key: string } | null;
}
export function parseCSV(text: string): ParsedCSV;
```

From src/lib/insight-engine.ts:
```typescript
export interface SessionFlag {
  severity: 'normal' | 'attention' | 'critical';
  canonical_key: string;
  parameter_key: string;
  message: string;
  evidence: FlagEvidence;
}
export function evaluateRules(parsed: ParsedCSV, rules: Rule[]): SessionFlag[];
export function computeParameterSummaries(parsed: ParsedCSV): ParameterSummary[];
// Rule is not exported — define inline in tests or cast with `as any`
```

From src/lib/canonical-params.ts:
```typescript
export function matchCanonicalKey(header: string): { canonical_key: string; label: string; unit: string } | null;
export const CANONICAL_PARAMS: CanonicalMapping[];
export const PRIUS_PRIORITY_KEYS: string[];
```

From src/hooks/use-cars.ts:
```typescript
// Imports: supabase (for indirect mock), getUserCars, createCarProfile, deleteCarProfile from '@/lib/db'
// The hook calls getUserCars(), createCarProfile(), deleteCarProfile() — mock these, not supabase directly
export function useCars(): {
  cars: CarProfile[];
  selectedCar: CarProfile | null;
  selectedCarId: string | null;
  loading: boolean;
  error: string | null;
  createCar(name: string, notes?: string): Promise<CarProfile>;
  updateCar(id: string, updates: Partial<Pick<CarProfile, 'name' | 'notes'>>): Promise<void>;
  deleteCar(id: string): Promise<void>;
  selectCar(id: string | null): void;
  refresh(): Promise<void>;
}
```

From src/contexts/AuthContext.tsx:
```typescript
// supabase.auth.getSession() called on mount — returns { data: { session } }
// supabase.auth.onAuthStateChange(cb) called on mount — returns { data: { subscription: { unsubscribe } } }
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element;
export function useAuth(): AuthContextType;
// AuthContextType: { user, session, loading, signIn, signInWithGoogle, signUp, signOut, resetPassword }
```

From src/pages/CarsPage.tsx:
```typescript
// Consumes useCarsContext() — must be wrapped in CarsProvider
// Renders: car list grid | empty-state card | loading spinner (PageLoader)
// Contains: Dialog (Add Vehicle) triggered by "Add Vehicle" button
export default function CarsPage(): JSX.Element;
```

From src/components/FlagsPanel.tsx:
```typescript
interface FlagsPanelProps {
  flags: Flag[];  // Flag: { severity: string; canonical_key: string; parameter_key: string; message: string; evidence?: Record<string, unknown> | null }
  limit?: number;
}
// Renders: CheckCircle card when flags.length === 0
// Renders: severity-critical or severity-attention Card per flag
export default function FlagsPanel(props: FlagsPanelProps): JSX.Element;
```
</interfaces>

<tasks>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TASK 1 — Infrastructure: coverage dep + test utilities + fixtures
     Estimated context: ~15% (config + utility files, no complex logic)
     ═══════════════════════════════════════════════════════════════════════════ -->

<task type="auto">
  <name>Task 1: Install coverage, write test utilities and fixtures</name>
  <files>
    package.json,
    src/test/utils/supabase-mock.ts,
    src/test/utils/render.tsx,
    src/test/fixtures/sample.csv,
    src/test/fixtures/sessions.ts
  </files>
  <action>
**Step 1 — Install @vitest/coverage-v8 and add test:coverage script.**

Run: `npm install --save-dev @vitest/coverage-v8`

Add to package.json `"scripts"`:
```json
"test:coverage": "vitest run --coverage"
```

**Step 2 — Create `src/test/utils/supabase-mock.ts`.**

Export a factory `createSupabaseMock()` that returns a typed mock object matching the shape of the real supabase client used by AuthContext and use-cars. The mock must cover:
- `auth.getSession` — vi.fn() resolving `{ data: { session: null }, error: null }`
- `auth.onAuthStateChange` — vi.fn() returning `{ data: { subscription: { unsubscribe: vi.fn() } } }`
- `auth.signInWithPassword` — vi.fn() resolving `{ error: null }`
- `auth.signOut` — vi.fn() resolving `{ error: null }`
- `auth.signUp` — vi.fn() resolving `{ data: { user: null, session: null }, error: null }`
- `from` — vi.fn() returning a chainable query builder: `{ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null }), insert: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis() }`

Export a helper `mockSession(overrides?)` that returns a minimal Supabase `Session`-shaped object for use in auth tests.

Do NOT import from `@supabase/supabase-js` directly in this mock file — construct plain objects. This avoids real network initialization.

**Step 3 — Create `src/test/utils/render.tsx`.**

Export a custom `render(ui, options?)` function using `@testing-library/react` that wraps the given `ui` in:
1. `QueryClientProvider` (from `@tanstack/react-query`) — create a fresh `QueryClient` per call with `defaultOptions: { queries: { retry: false } }`
2. `AuthProvider` (from `@/contexts/AuthContext`)
3. `CarsProvider` (from `@/contexts/CarsContext`)
4. `MemoryRouter` (from `react-router-dom`) — needed because CarsPage uses AppLayout which likely uses navigation

Re-export all exports from `@testing-library/react` so callers can do `import { screen, fireEvent } from '@/test/utils/render'`.

Important: Before adding this wrapper, check if AppLayout or CarsPage imports anything from `react-router-dom`. If `MemoryRouter` causes issues (e.g., double-routing), try wrapping just the component under test in a minimal `<BrowserRouter>` instead. Use `MemoryRouter` as the default.

**Step 4 — Create `src/test/fixtures/sample.csv`.**

Write a minimal but realistic OBD2 CSV with:
- Header row: `Time,Coolant Temp (°C),Engine RPM,Vehicle Speed (km/h),Battery Voltage (V)`
- 10 data rows with realistic values. Include at least 5 rows where `Coolant Temp` is 105 (above a critical threshold of ~103°C) so the integration test can assert a flag is produced.

Example rows (adjust to match real parsing):
```
0,85,800,0,12.4
1,90,1200,30,12.5
2,95,2000,60,12.6
3,100,2500,80,12.4
4,105,3000,90,12.3
5,106,3200,95,12.2
6,108,3500,100,12.1
7,110,3800,105,12.0
8,112,4000,110,11.9
9,115,4200,115,11.8
```

**Step 5 — Create `src/test/fixtures/sessions.ts`.**

Export typed factory functions:
- `makeCarProfile(overrides?: Partial<CarProfile>): CarProfile` — returns `{ id: 'car-1', name: 'Test Car', notes: null, created_at: '2026-01-01T00:00:00Z', user_id: 'user-1' }` merged with overrides. Import `CarProfile` from `@/lib/db`.
- `makeSessionFlag(overrides?: Partial<SessionFlag>): SessionFlag` — returns a minimal flag with `severity: 'attention'`, `canonical_key: 'coolant_temp'`, `parameter_key: 'Coolant Temp (°C)'`, `message: 'Coolant temp exceeded attention threshold.'`, and a valid `evidence` object. Import `SessionFlag` from `@/lib/insight-engine`.

Export two pre-built fixture arrays:
- `SAMPLE_CARS: CarProfile[]` — array of 2 cars using makeCarProfile
- `SAMPLE_FLAGS: SessionFlag[]` — array of 1 critical flag and 1 attention flag
  </action>
  <verify>
    <automated>npm run test -- --reporter=verbose 2>&1 | tail -20</automated>
  </verify>
  <done>
    - `@vitest/coverage-v8` listed in `package.json` devDependencies
    - `"test:coverage"` script present in package.json
    - `src/test/utils/supabase-mock.ts` exports `createSupabaseMock` and `mockSession`
    - `src/test/utils/render.tsx` exports custom `render` and re-exports testing-library
    - `src/test/fixtures/sample.csv` exists with header + 10 data rows
    - `src/test/fixtures/sessions.ts` exports `makeCarProfile`, `makeSessionFlag`, `SAMPLE_CARS`, `SAMPLE_FLAGS`
    - `npm test` still passes (existing example.test.ts still green)
  </done>
</task>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TASK 2 — Pure-function unit tests: csv-parser, canonical-params, insight-engine
     Estimated context: ~20% (3 test files, logic-heavy but pure functions)
     ═══════════════════════════════════════════════════════════════════════════ -->

<task type="auto" tdd="true">
  <name>Task 2: Unit tests — csv-parser, canonical-params, insight-engine</name>
  <files>
    src/test/csv-parser.test.ts,
    src/test/canonical-params.test.ts,
    src/test/insight-engine.test.ts
  </files>
  <behavior>
    csv-parser:
    - parseCSV('') returns { headers: [], rows: [], headerMapping: {}, timeColumn: null }
    - parseCSV with 1 header row and 0 data rows returns rows: []
    - parseCSV with comma-separated headers maps them correctly
    - parseCSV with semicolon delimiter is detected automatically (semicolons > commas in line 1)
    - parseCSV detects a 'Time' column as { type: 'seconds', key: 'Time' }
    - parseCSV converts numeric string values to numbers in rows (e.g. '85' -> 85)
    - parseCSV with a non-numeric cell stores it as a string (not null)
    - parseCSV with an empty cell stores it as null
    - parseCSV maps a header 'Coolant Temp (°C)' to canonical_key 'coolant_temp' via headerMapping

    canonical-params:
    - matchCanonicalKey('coolant') returns { canonical_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C' }
    - matchCanonicalKey('Engine Speed') returns { canonical_key: 'engine_rpm', ... } (matches 'rpm' keyword? No — 'engine speed' keyword matches)
    - matchCanonicalKey('RPM') returns { canonical_key: 'engine_rpm', ... }
    - matchCanonicalKey('completely_unknown_xyz') returns null
    - matchCanonicalKey('COOLANT') returns a match (case-insensitive)
    - matchCanonicalKey('soc') returns { canonical_key: 'hybrid_battery_soc', ... }

    insight-engine (evaluateRules):
    - Given rows all within normal range, evaluateRules returns []
    - Given 5 rows where coolant_temp = 105 (above warn_max of ~100), returns at least 1 flag with severity 'attention' or 'critical'
    - Given rows where coolant_temp = 120 sustained (critical_max ~110), returns flag with severity 'critical'
    - A flag for coolant_temp has canonical_key: 'coolant_temp'
    - evaluateRules returns [] when the rule's canonical_key has no matching column in headerMapping
    - evaluateRules with empty rows array returns []

    Note: `Rule` is not exported from insight-engine. Define minimal rule objects inline in tests using `as any` or by casting. A minimal coolant rule looks like:
    ```ts
    const coolantRule = {
      canonical_key: 'coolant_temp', parameter_key: 'Coolant Temp',
      label: 'Coolant Temp', normal_min: 70, normal_max: 100,
      warn_min: null, warn_max: 100, critical_min: null, critical_max: 110,
      min_duration_seconds: 2, notes: 'Attention: temp high. Critical: temp very high.'
    };
    ```
  </behavior>
  <action>
Write three test files. All imports are from the real source modules — no mocking is needed (pure functions).

**`src/test/csv-parser.test.ts`:**
Import `parseCSV` from `@/lib/csv-parser`. Write a `describe('parseCSV')` block covering each behavior case above. Use `describe` sub-blocks for readability (e.g. `describe('empty input')`, `describe('delimiter detection')`, `describe('type coercion')`).

Key edge cases to cover explicitly:
1. Empty string input → headers:[], rows:[], headerMapping:{}, timeColumn:null
2. Header only (no data rows) → rows:[]
3. Semicolon delimiter detected when `';'` count exceeds `','` count in first line
4. `'Time'` header with numeric values → `timeColumn.type === 'seconds'`
5. `'Coolant Temp (°C)'` header maps to `canonical_key: 'coolant_temp'`
6. Numeric cell `'85'` → row value is `85` (number)
7. Empty cell `''` → row value is `null`
8. Non-numeric string cell (e.g. `'ACTIVE'`) → row value is `'ACTIVE'` (string)

**`src/test/canonical-params.test.ts`:**
Import `matchCanonicalKey`, `CANONICAL_PARAMS` from `@/lib/canonical-params`. Write a `describe('matchCanonicalKey')` block.

Key cases:
1. `'coolant'` → `{ canonical_key: 'coolant_temp' }` (partial keyword match)
2. `'RPM'` → `{ canonical_key: 'engine_rpm' }` (case-insensitive)
3. `'COOLANT'` → not null (case-insensitive)
4. `'soc'` → `{ canonical_key: 'hybrid_battery_soc' }`
5. `'0x05'` → `{ canonical_key: 'coolant_temp' }` (OBD2 PID hex code)
6. `'completely_unknown_xyz_abc'` → `null`

**`src/test/insight-engine.test.ts`:**
Import `evaluateRules` and `computeParameterSummaries` from `@/lib/insight-engine`. Import `parseCSV` from `@/lib/csv-parser` to build `ParsedCSV` objects for test input — this is the cleanest approach.

Helper: write a local `buildParsedCSV(headers: string[], rows: number[][])` function that uses `parseCSV` on a dynamically-constructed CSV string. This ensures the headerMapping is built by real code.

Key cases:
1. All values in range → `evaluateRules` returns `[]`
2. Coolant > warn_max for 3+ samples with sampleInterval=1 → returns flag with `severity: 'attention'`
3. Coolant > critical_max for 3+ samples → returns flag with `severity: 'critical'` (not attention, due to `continue` after critical)
4. Rule's canonical_key not present in CSV → returns `[]` (matchingHeader is undefined → continue)
5. Empty rows → returns `[]`
6. `computeParameterSummaries` with 3 coolant values [85, 90, 95] → summary has `min:85, max:95, avg:90`
  </action>
  <verify>
    <automated>npx vitest run src/test/csv-parser.test.ts src/test/canonical-params.test.ts src/test/insight-engine.test.ts --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>
    - All tests in all three files pass (0 failures)
    - csv-parser.test.ts has >= 8 test cases covering empty input, delimiter detection, type coercion, header mapping
    - canonical-params.test.ts has >= 6 test cases covering keywords, case insensitivity, null for unknown
    - insight-engine.test.ts has >= 6 test cases covering normal/attention/critical severity, missing column, empty rows
  </done>
</task>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TASK 3 — Hook + context tests: useCars and AuthContext
     Estimated context: ~20% (mocking + async renderHook patterns)
     ═══════════════════════════════════════════════════════════════════════════ -->

<task type="auto" tdd="true">
  <name>Task 3: Hook and context tests — useCars and AuthContext</name>
  <files>
    src/test/use-cars.test.ts,
    src/test/auth-context.test.tsx
  </files>
  <behavior>
    useCars (via renderHook, mocking '@/lib/db'):
    - On mount, calls getUserCars() and sets cars from the result
    - After load, loading transitions false
    - Auto-selects cars[0].id as selectedCarId when no prior localStorage value
    - createCar() adds the new car to the front of the list and sets it as selectedCarId
    - deleteCar(id) removes the car from the list; if deleted car was selectedCarId, switches to next car in remaining list
    - Error from getUserCars() sets error string (not throws)

    AuthContext (via render + useAuth(), mocking '@/integrations/supabase/client'):
    - Initial render: loading=true while getSession() has not resolved
    - After getSession() resolves with null session: loading=false, user=null, session=null
    - After getSession() resolves with a valid session: loading=false, user matches session.user
    - signIn() calls supabase.auth.signInWithPassword with correct credentials
    - signOut() calls supabase.auth.signOut
    - signIn() throws when supabase returns an error
  </behavior>
  <action>
**`src/test/use-cars.test.ts`:**

Mock `@/lib/db` (NOT the supabase client directly, since useCars calls db functions):
```ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCars } from '@/hooks/use-cars';
import * as db from '@/lib/db';
import { makeCarProfile, SAMPLE_CARS } from './fixtures/sessions';

vi.mock('@/lib/db', () => ({
  getUserCars: vi.fn(),
  createCarProfile: vi.fn(),
  updateCarProfile: vi.fn(),
  deleteCarProfile: vi.fn(),
}));
```

Before each test, clear mocks and set localStorage. Use `localStorage.clear()` in `beforeEach`.

Test cases:
1. `getUserCars` resolves with `SAMPLE_CARS` → after `waitFor(() => !result.current.loading)`, `result.current.cars` equals `SAMPLE_CARS`
2. Auto-selection: `selectedCarId` equals `SAMPLE_CARS[0].id` after load
3. `createCar('New Car')` → mock `createCarProfile` to return a new car → after `act(async () => await result.current.createCar('New Car'))`, new car is at `cars[0]` and `selectedCarId` is `newCar.id`
4. `deleteCar(SAMPLE_CARS[0].id)` when `SAMPLE_CARS[0]` is selected → after deletion, `selectedCarId` switches to `SAMPLE_CARS[1].id`
5. `getUserCars` rejects → `result.current.error` is a non-null string

Important renderHook wrapper: `useCars` uses localStorage which is available in jsdom. No extra wrapper needed unless imports fail — if `@/integrations/supabase/client` is imported transitively by `@/lib/db`, also mock the supabase client using `createSupabaseMock`:
```ts
import { createSupabaseMock } from './utils/supabase-mock';
vi.mock('@/integrations/supabase/client', () => ({ supabase: createSupabaseMock() }));
```

**`src/test/auth-context.test.tsx`:**

Mock `@/integrations/supabase/client` using `createSupabaseMock`:
```ts
import { createSupabaseMock, mockSession } from './utils/supabase-mock';

const mockSupabase = createSupabaseMock();
vi.mock('@/integrations/supabase/client', () => ({ supabase: mockSupabase }));
```

Write a helper component `AuthConsumer` that renders `<div data-testid="user">{user?.email ?? 'null'}</div><div data-testid="loading">{loading ? 'loading' : 'ready'}</div>` using `useAuth()`.

Test cases:
1. While `getSession` is pending (make it never resolve), `loading` renders as `'loading'`
2. `getSession` resolves with `{ data: { session: null } }` → `loading` renders `'ready'`, `user` renders `'null'`
3. `getSession` resolves with a valid session (use `mockSession({ user: { email: 'test@example.com' } })`) → `user` renders `'test@example.com'`
4. `signIn(email, password)` → asserts `mockSupabase.auth.signInWithPassword` was called with `{ email, password }`
5. `signOut()` → asserts `mockSupabase.auth.signOut` was called
6. `signIn()` when mock returns `{ error: { message: 'Invalid credentials' } }` → the returned promise rejects

Use `render(<AuthProvider><AuthConsumer /></AuthProvider>)` — import `render` from `@testing-library/react` directly (not the custom render wrapper) since AuthProvider itself is under test here.

Wrap assertions with `waitFor` for async state updates.
  </action>
  <verify>
    <automated>npx vitest run src/test/use-cars.test.ts src/test/auth-context.test.tsx --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>
    - All tests pass in use-cars.test.ts (>= 5 cases)
    - All tests pass in auth-context.test.tsx (>= 6 cases)
    - Tests use vi.mock for db and supabase client — no real network calls made
    - loading state transitions are tested (initial true → false after resolve)
  </done>
</task>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TASK 4 — Component tests: CarsPage, FlagsPanel, and integration test
     Estimated context: ~20% (3 more test files, RTL render patterns)
     ═══════════════════════════════════════════════════════════════════════════ -->

<task type="auto" tdd="true">
  <name>Task 4: Component tests — CarsPage, FlagsPanel, and CSV upload integration test</name>
  <files>
    src/test/cars-page.test.tsx,
    src/test/flags-panel.test.tsx,
    src/test/csv-upload-flow.test.ts
  </files>
  <behavior>
    CarsPage:
    - When cars=[] and loading=false, renders "No Vehicles Yet" text
    - When cars=[car1, car2] and loading=false, renders both car names in the DOM
    - Clicking "Add Vehicle" button opens a dialog containing "Add New Vehicle" heading

    FlagsPanel:
    - When flags=[], renders "All parameters look normal" text
    - When flags=[{ severity:'critical', ... }], renders 'critical' text (the severity label)
    - When flags=[{ severity:'attention', ... }], renders 'attention' text
    - When limit=1 and flags has 3 items, renders "+2 more flags" text
    - Evidence values (max, avg, pct_out_of_range) are rendered when evidence is present

    CSV upload integration:
    - Parse sample.csv fixture text → call evaluateRules with a coolant threshold rule → result has >= 1 flag
    - The flag's canonical_key is 'coolant_temp'
    - parseCSV on sample.csv produces rows.length === 10
    - computeParameterSummaries includes a summary for 'coolant_temp' with max >= 115
  </behavior>
  <action>
**`src/test/flags-panel.test.tsx`:**

FlagsPanel is a pure presentational component — no context needed. Import directly and use `render` from `@testing-library/react`.

```ts
import { render, screen } from '@testing-library/react';
import FlagsPanel from '@/components/FlagsPanel';
import { SAMPLE_FLAGS, makeSessionFlag } from './fixtures/sessions';
```

Test cases:
1. `<FlagsPanel flags={[]} />` → `screen.getByText('All parameters look normal')` exists
2. `<FlagsPanel flags={[makeSessionFlag({ severity: 'critical', message: 'Engine critical' })]} />` → `screen.getByText(/critical/i)` in the severity label
3. `<FlagsPanel flags={SAMPLE_FLAGS} />` → renders without crashing (smoke test)
4. `<FlagsPanel flags={[...Array(3).fill(makeSessionFlag())]} limit={1} />` → `screen.getByText(/\+2 more flags/i)` exists
5. `<FlagsPanel flags={[makeSessionFlag({ evidence: { max: 115.0, avg: 100.5, pct_out_of_range: 50.0 } })]} />` → `screen.getByText(/115/)` and `screen.getByText(/100/)` exist

**`src/test/cars-page.test.tsx`:**

CarsPage uses `useCarsContext()` so it must be wrapped in a `CarsProvider`. CarsProvider calls `useCars()` which calls `@/lib/db` functions. Mock both `@/lib/db` and `@/integrations/supabase/client`.

Also mock `@/components/AppLayout` to render just children — AppLayout likely wraps with navigation that creates jsdom issues:
```ts
vi.mock('@/components/AppLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
```

Also mock `@/components/PageLoader`:
```ts
vi.mock('@/components/PageLoader', () => ({
  PageLoader: () => <div data-testid="loading-spinner" />,
}));
```

Import the custom `render` from `./utils/render` (which wraps CarsProvider):

Test cases:
1. With `getUserCars` resolving `[]`, after `waitFor`, `screen.getByText('No Vehicles Yet')` exists
2. With `getUserCars` resolving `SAMPLE_CARS`, after `waitFor`, `screen.getByText('Test Car')` exists (SAMPLE_CARS[0].name)
3. Click "Add Vehicle" button → `screen.getByText('Add New Vehicle')` appears (dialog heading)

For case 3: use `fireEvent.click(screen.getByRole('button', { name: /add vehicle/i }))` and check the dialog heading appears.

**`src/test/csv-upload-flow.test.ts`:**

This is a pure TypeScript integration test — no React rendering. No mocks needed (tests real parse + engine behavior).

```ts
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseCSV } from '@/lib/csv-parser';
import { evaluateRules, computeParameterSummaries } from '@/lib/insight-engine';
```

Read the sample.csv fixture:
```ts
const csvText = readFileSync(resolve(__dirname, './fixtures/sample.csv'), 'utf-8');
```

Define the coolant rule inline (same shape as Task 2's note about Rule interface):
```ts
const coolantRule = {
  canonical_key: 'coolant_temp',
  parameter_key: 'Coolant Temp',
  label: 'Coolant Temp',
  normal_min: 70, normal_max: 100,
  warn_min: null, warn_max: 100,
  critical_min: null, critical_max: 110,
  min_duration_seconds: 2,
  notes: 'Attention: coolant temp high. Critical: coolant temp very high.'
};
```

Test cases:
1. `parseCSV(csvText).rows.length === 10`
2. `parseCSV(csvText).timeColumn` is not null and type is `'seconds'`
3. `evaluateRules(parseCSV(csvText), [coolantRule]).length >= 1`
4. The flag returned has `canonical_key: 'coolant_temp'`
5. `computeParameterSummaries(parseCSV(csvText))` includes an entry where `canonical_key === 'coolant_temp'` and `max >= 115`

Note on `readFileSync` in vitest: The test environment is jsdom but Node.js `fs` is available in vitest. If the `__dirname` is unavailable (ESM), use:
```ts
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
```
  </action>
  <verify>
    <automated>npx vitest run src/test/flags-panel.test.tsx src/test/cars-page.test.tsx src/test/csv-upload-flow.test.ts --reporter=verbose 2>&1 | tail -50</automated>
  </verify>
  <done>
    - All tests pass in flags-panel.test.tsx (>= 5 cases)
    - All tests pass in cars-page.test.tsx (>= 3 cases: empty state, car list, dialog open)
    - All tests pass in csv-upload-flow.test.ts (>= 5 cases)
    - No real Supabase network calls made in any test
  </done>
</task>

</tasks>

<verification>
Run the full test suite and coverage report to confirm all targets are met.

Full suite:
```bash
npm test
```
Expected: All tests pass. Zero failures across example.test.ts and all 8 new test files.

Coverage:
```bash
npm run test:coverage
```
Expected output: `src/lib/csv-parser.ts`, `src/lib/insight-engine.ts`, and `src/lib/canonical-params.ts` each show >= 70% line coverage in the `Lines` column.

Individual sanity checks:
- `npx vitest run src/test/csv-upload-flow.test.ts` — integration test green (proves parse + engine pipeline works end to end)
- `npx vitest run src/test/auth-context.test.tsx` — auth context loading state resolves correctly
</verification>

<success_criteria>
- `npm test` exits with code 0 — all tests pass
- `npm run test:coverage` shows >= 70% line coverage on every file in `src/lib/`
- 8 new test files exist in `src/test/`, each with >= 3 meaningful test cases (not trivial)
- 4 new utility/fixture files exist in `src/test/utils/` and `src/test/fixtures/`
- `@vitest/coverage-v8` is in `package.json` devDependencies
- `test:coverage` script is in `package.json` scripts
- No test makes a real network request (all Supabase calls are mocked)
- The CSV-to-flags integration test demonstrates end-to-end correctness of the parsing pipeline with the sample fixture
</success_criteria>

<output>
After all tasks complete successfully, create `.planning/phases/06-test-coverage/06-01-SUMMARY.md` documenting:
- Files created (all 13 new files)
- Test counts per file
- Coverage numbers from `npm run test:coverage` output
- Any patterns established for future test files (mock conventions, fixture patterns)
</output>
