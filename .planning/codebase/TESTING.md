# Testing Patterns

**Analysis Date:** 2026-05-15

## Test Framework

**Runner:**
- Vitest 3.2.4
- Config: `vitest.config.ts` (located at `/c/Users/Vanildo/Dev/car-insights-ai/vitest.config.ts`)

**Assertion Library:**
- Vitest built-in expect API (Vitest provides assertions)
- Testing Library: `@testing-library/react` 16.0.0 for component testing
- DOM utilities: `@testing-library/jest-dom` 6.6.0

**Environment:**
- jsdom (browser-like environment)
- Globals enabled (no need to import `describe`, `it`, `expect`)

**Run Commands:**
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode for development
```

## Test File Organization

**Location:**
- Tests co-located with source code in same directory
- Test files in `src/test/` for shared test utilities and setup

**Naming:**
- Pattern: `*.test.ts` or `*.spec.ts`
- Include file: `src/**/*.{test,spec}.{ts,tsx}` (per `vitest.config.ts:11`)

**Current State:**
- Only one test file exists: `src/test/example.test.ts` (minimal example)
- Most application code lacks tests

**Structure:**
```
src/test/
├── setup.ts           # Global test setup and polyfills
└── example.test.ts    # Example test file
```

## Test Setup

**Global Setup:**
- File: `src/test/setup.ts`
- Initializes `@testing-library/jest-dom` matchers
- Polyfills `window.matchMedia` for components that use media queries

**Setup File Contents:**
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

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from "vitest";

describe("feature name", () => {
  it("should do something specific", () => {
    expect(true).toBe(true);
  });
});
```

**Current Example (from `src/test/example.test.ts`):**
```typescript
import { describe, it, expect } from "vitest";

describe("example", () => {
  it("should pass", () => {
    expect(true).toBe(true);
  });
});
```

**Patterns to Implement:**
- Use `describe()` for grouping related tests
- Use `it()` for individual test cases
- Clear test names describing expected behavior: "should [action] when [condition]"
- One assertion per test when possible (though multiple related assertions acceptable)

## Mocking

**Framework:**
- Vitest provides mocking via `vi` object (not yet used in codebase)
- React Testing Library for component interaction testing

**What Needs Mocking:**
- Supabase client calls (in `src/integrations/supabase/client.ts`)
- API calls (Gemini, Google Generative AI)
- Browser APIs (localStorage, fetch)
- File uploads

**Setup Pattern (To Be Implemented):**
```typescript
// Example for mocking Supabase (not yet in codebase)
import { vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      // ... other methods
    },
    // ... other modules
  }
}));
```

## Testing React Components

**Pattern (To Be Implemented):**
```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MyComponent from '@/components/MyComponent';

describe('MyComponent', () => {
  it('should render and respond to user interaction', async () => {
    render(<MyComponent />);
    
    const button = screen.getByRole('button', { name: /click me/i });
    await userEvent.click(button);
    
    expect(screen.getByText(/result/i)).toBeInTheDocument();
  });
});
```

## Fixtures and Factories

**Test Data:**
- No fixtures currently defined
- Need to create factory functions for:
  - CarProfile objects
  - ParsedCSV data
  - Session objects
  - Chat messages

**Location:**
- Would be placed in `src/test/fixtures.ts` or similar
- Each domain gets own fixture file: `src/test/fixtures/cars.ts`, `src/test/fixtures/sessions.ts`

## Coverage

**Requirements:** None enforced currently

**View Coverage (When Ready):**
```bash
vitest run --coverage
# Requires @vitest/coverage-* package
```

**Recommended Coverage Targets:**
- Utility functions (`src/lib/`): 80%+
- Hooks (`src/hooks/`): 70%+
- Components (`src/components/`): 60%+ (integration tests less critical)

## Test Types Needed

**Unit Tests:**
- Scope: Individual functions and hooks
- What to test:
  - `src/lib/csv-parser.ts`: parseCSV logic, delimiter detection, row parsing
  - `src/lib/canonical-params.ts`: parameter matching logic
  - `src/lib/insight-engine.ts`: rule evaluation, flag generation
  - `src/lib/default-rules.ts`: rule definitions
  - `src/hooks/use-cars.ts`: car management state and operations

**Component Tests:**
- Scope: React component rendering and user interactions
- What to test:
  - `src/components/PrivateRoute.tsx`: redirects unauthenticated users
  - `src/components/PageLoader.tsx`: shows after 150ms delay
  - `src/components/ChatBubble.tsx`: opens/closes chat window
  - `src/components/AIAnalysisCard.tsx`: renders analysis data correctly

**Hook Tests:**
- Scope: Custom hooks in isolation
- What to test:
  - `src/hooks/use-csv-upload.ts`: file upload flow, progress tracking, error handling
  - `src/hooks/use-cars.ts`: state management, localStorage persistence
  - `src/hooks/use-toast.ts`: toast notifications

**Integration Tests:**
- Scope: Multiple components/features working together
- What to test:
  - Upload flow: file selection → parsing → progress → completion
  - Authentication flow: login → redirect → protected route access
  - Chat interaction: message sending → AI response → display

**E2E Tests:**
- Framework: None detected (would use Playwright or Cypress)
- Not yet implemented
- Consider for critical user flows: auth, upload, chat

## Common Testing Scenarios

**Testing Async Operations:**
```typescript
// Pattern using async/await
it('should load data', async () => {
  const { result } = renderHook(() => useData());
  
  await waitFor(() => {
    expect(result.current.data).toBeDefined();
  });
});
```

**Testing Error States:**
```typescript
it('should handle errors gracefully', async () => {
  // Mock error condition
  vi.mocked(supabase.auth.signIn).mockRejectedValue(
    new Error('Invalid credentials')
  );
  
  // Test error handling
  expect(() => signIn('user@test.com', 'wrong')).rejects.toThrow();
});
```

**Testing State Changes:**
```typescript
it('should update state on action', async () => {
  const { result } = renderHook(() => useCars());
  
  await act(async () => {
    await result.current.createCar('New Car');
  });
  
  expect(result.current.cars).toHaveLength(1);
});
```

## Critical Testing Gaps

The following critical areas lack test coverage and should be prioritized:

**CSV Parsing:**
- File: `src/lib/csv-parser.ts`
- Gap: No tests for delimiter detection, row parsing, or long-format pivoting
- Impact: CSV upload failures could go undetected
- Priority: HIGH

**Session Upload Flow:**
- File: `src/hooks/use-csv-upload.ts`
- Gap: Complex multi-step process (read, parse, save, analyze) untested
- Impact: Data loss or silent failures possible
- Priority: HIGH

**Authentication:**
- File: `src/contexts/AuthContext.tsx`
- Gap: No tests for login, signup, OAuth, session persistence
- Impact: Users could lose access, security issues undetected
- Priority: HIGH

**Database Operations:**
- File: `src/lib/db.ts`
- Gap: No tests for Supabase interactions
- Impact: Data corruption or loss possible
- Priority: MEDIUM

**Rules Engine:**
- File: `src/lib/insight-engine.ts`
- Gap: No tests for rule evaluation or flag generation
- Impact: Incorrect diagnostics provided to users
- Priority: MEDIUM

**Chat System:**
- Files: `src/components/chat/`, `src/lib/chat/`
- Gap: New chat system completely untested
- Impact: Message loss, state corruption possible
- Priority: MEDIUM

**Components:**
- Most components lack unit tests
- Basic rendering tests needed for: `PageLoader`, `PrivateRoute`, `AIAnalysisCard`
- Priority: LOW (integration testing may be sufficient)

## Setup Required for Testing

Before writing additional tests, set up:

1. **Install test utilities (if not present):**
   ```bash
   npm install --save-dev @testing-library/user-event
   npm install --save-dev @testing-library/react-hooks
   npm install --save-dev vitest-canvas-mock  # If canvas testing needed
   ```

2. **Create fixture factories** in `src/test/fixtures/`:
   - `cars.ts`: CarProfile factories
   - `sessions.ts`: Session and ParsedCSV factories
   - `messages.ts`: Chat message factories

3. **Mock Supabase** in setup or individual tests:
   - Mock auth methods
   - Mock database queries
   - Mock realtime subscriptions

4. **Mock external APIs:**
   - Google Generative AI
   - Gemini API

5. **Create utilities** in `src/test/`:
   - Component render helpers with providers
   - Hook test utilities
   - Common setup/teardown functions

---

*Testing analysis: 2026-05-15*
