# Testing Patterns

**Analysis Date:** 2026-05-29

## Test Framework

**Runner:**
- Vitest `^3.2.4`
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in (`expect`, `describe`, `it`) + `@testing-library/jest-dom` for DOM matchers

**Component Testing:**
- `@testing-library/react` `^16.0.0`

**Run Commands:**
```bash
npm run test          # Run all tests once (vitest run)
npm run test:watch    # Watch mode (vitest)
```

Coverage command is not configured in `package.json`.

## Test File Organization

**Location:**
- Central test directory: `src/test/` — only location currently containing test files
- vitest configured to scan `src/**/*.{test,spec}.{ts,tsx}` — supports co-located tests alongside source files

**Current test files:**
- `src/test/example.test.ts` — placeholder passing test
- `src/test/setup.ts` — global test setup (imported via `vitest.config.ts` `setupFiles`)

**Naming:**
- Files: `*.test.ts` or `*.test.tsx` (spec suffix also valid per config)
- Co-location is supported: a test for `src/lib/csv-parser.ts` would go at `src/lib/csv-parser.test.ts`

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from "vitest";

describe("example", () => {
  it("should pass", () => {
    expect(true).toBe(true);
  });
});
```

**Globals mode:**
- `globals: true` in `vitest.config.ts` — `describe`, `it`, `expect` are available without import
- The example test still imports them explicitly — both styles are valid

## Setup File

`src/test/setup.ts` runs before every test file and:
1. Imports `@testing-library/jest-dom` — adds DOM matchers (`toBeInTheDocument`, `toHaveValue`, etc.)
2. Mocks `window.matchMedia` — required for components that use media queries (PWA install prompt, theme)

```typescript
import "@testing-library/jest-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
```

## Test Environment

- `environment: "jsdom"` — DOM APIs available in tests
- `@` path alias configured in `vitest.config.ts` to match production config — imports like `@/lib/utils` work in tests

## Mocking

**Framework:** Vitest built-in (`vi.mock`, `vi.fn`, `vi.spyOn`)

**What to mock:**
- Supabase client (`@/integrations/supabase/client`) — avoids real network calls
- `import.meta.env` variables — needed for environment-dependent branches
- `window.matchMedia` — already mocked globally in `src/test/setup.ts`

**Example pattern (not yet present — use this for new tests):**
```typescript
import { vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnThis(), eq: vi.fn() }),
  },
}));
```

## Coverage

**Requirements:** Not enforced — no coverage threshold configured
**Coverage command:** Not configured in `package.json` scripts

To run coverage manually:
```bash
npx vitest run --coverage
```

## Test Types

**Unit Tests:**
- Supported and configured — intended for `src/lib/` utility functions (csv-parser, insight-engine, rule-resolver, vin-decoder, downsample)
- No actual unit tests written yet (only the placeholder `example.test.ts`)

**Component Tests:**
- `@testing-library/react` is installed — React components can be tested with `render()`
- No component tests exist yet

**Integration Tests:**
- No integration test files found

**E2E Tests:**
- No Playwright or Cypress configuration detected
- No e2e test files found

## Current State

The test infrastructure is fully configured but nearly empty:

| Item | Status |
|------|--------|
| Vitest runner | Configured |
| jsdom environment | Configured |
| @testing-library/react | Installed |
| @testing-library/jest-dom | Installed, imported in setup |
| window.matchMedia mock | In setup.ts |
| Path alias (@/) | Working |
| Actual unit tests | 1 placeholder only |
| Component tests | None |
| Integration tests | None |
| E2E tests | None |
| Coverage enforcement | None |

## Adding New Tests

**For a utility function** (e.g., `src/lib/csv-parser.ts`):
- Create `src/lib/csv-parser.test.ts`
- Import the function directly using `@/lib/csv-parser`
- Use `describe`/`it`/`expect` (available as globals or via import)

**For a React component** (e.g., `src/components/AddVehicleForm.tsx`):
- Create `src/components/AddVehicleForm.test.tsx`
- Use `render` from `@testing-library/react`
- Mock Supabase and any context providers needed
- Wrap with required providers (`AuthProvider`, `CarsProvider`, etc.)

**For a hook** (e.g., `src/hooks/use-cars.ts`):
- Create `src/hooks/use-cars.test.ts`
- Use `renderHook` from `@testing-library/react`
- Mock `@/integrations/supabase/client` and `@/lib/db`

---

*Testing analysis: 2026-05-29*
