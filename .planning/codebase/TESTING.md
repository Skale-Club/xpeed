# Testing Patterns

**Analysis Date:** 2026-05-17

## Test Framework

**Runner:**
- Vitest 3.2.4
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in `expect` (jest-compatible API)
- `@testing-library/jest-dom` 6.6.0 for DOM matchers (`toBeInTheDocument`, etc.)
- `@testing-library/react` 16.0.0 installed but not yet used

**Run Commands:**
```bash
npm test              # vitest run (single pass, CI mode)
npm run test:watch   # vitest (watch mode for development)
```

**Coverage:**
- No `@vitest/coverage-*` package installed — coverage reports not available
- No coverage thresholds enforced

## Test File Organization

**Location:**
- Vitest includes: `src/**/*.{test,spec}.{ts,tsx}` (per `vitest.config.ts:11`)
- Intended location: co-located with source OR in `src/test/`
- Current state: only `src/test/example.test.ts` exists — a placeholder

**Naming:**
- `*.test.ts` — TypeScript unit/integration tests
- `*.test.tsx` — Component tests (React JSX)
- `*.spec.ts` / `*.spec.tsx` — also recognized by Vitest

**Structure:**
```
src/test/
├── setup.ts           # Global setup (matchMedia polyfill, jest-dom matchers)
└── example.test.ts    # Placeholder only — not a real test
```

## Test Setup (`src/test/setup.ts`)

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

The setup file is minimal. Additional globals that must be polyfilled before writing component tests:
- `localStorage` (needed for `use-cars.ts` selection persistence)
- `crypto.randomUUID` (needed for `use-csv-upload.ts` and chat message IDs)
- `URL.createObjectURL` / `URL.revokeObjectURL` (needed for CSV download in `src/lib/db.ts`)
- `fetch` (if any code path bypasses the Supabase client)

## Current Test State

**The only test file is a placeholder:**
```typescript
// src/test/example.test.ts
import { describe, it, expect } from "vitest";

describe("example", () => {
  it("should pass", () => {
    expect(true).toBe(true);
  });
});
```

**Coverage: 0% of application code is tested.**

All critical paths — CSV parsing, insight engine, car management, chat, authentication — are completely untested.

## Writing New Tests — Standard Structure

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("ModuleName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("functionName", () => {
    it("should [expected behavior] when [condition]", () => {
      // arrange
      // act
      // assert
    });
  });
});
```

## Mocking

**Framework:** `vi` from Vitest

**Module mock pattern (for Supabase):**
```typescript
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ error: null }),
        download: vi.fn().mockResolvedValue({ data: null, error: null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  },
}));
```

**What to mock:**
- `@/integrations/supabase/client` — in every hook and DB layer test
- `@google/generative-ai` — in any test touching `src/lib/gemini-service.ts` or `src/components/chat/ChatContainer.tsx`
- `localStorage` — use `vi.spyOn(Storage.prototype, 'getItem')` for `use-cars.ts` tests
- `crypto.randomUUID` — `vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('test-uuid') })`

**What NOT to mock:**
- `src/lib/csv-parser.ts` — pure functions, test directly with CSV string inputs
- `src/lib/insight-engine.ts` — pure functions, test directly with `ParsedCSV` fixtures
- `src/lib/canonical-params.ts` — pure data + matching function, test directly
- `src/lib/chat/types.ts` — pure helper functions, test directly

## Priority Test Areas

### 1. CSV Parser — `src/lib/csv-parser.ts` (HIGHEST PRIORITY)

The CSV parser is the entry point for all user data. It handles multiple formats, delimiter detection, long-format pivoting, and time column detection. Bugs here silently corrupt all downstream analysis.

**Functions to test:**
- `parseCSV(text: string): ParsedCSV`
- Internal helpers indirectly: `detectDelimiter`, `parseCSVLine`, `detectTimeColumn`, `isNumeric`, `toNumber`

**Test cases to write:**
```typescript
// src/test/csv-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseCSV } from "@/lib/csv-parser";

describe("parseCSV", () => {
  it("should parse a basic comma-delimited CSV", () => {
    const csv = "Time,RPM,Coolant Temp\n0,800,75\n1,850,76";
    const result = parseCSV(csv);
    expect(result.headers).toEqual(["Time", "RPM", "Coolant Temp"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]["RPM"]).toBe(800);
  });

  it("should detect semicolon delimiter", () => {
    const csv = "Time;RPM;Coolant Temp\n0;800;75";
    const result = parseCSV(csv);
    expect(result.rows[0]["RPM"]).toBe(800);
  });

  it("should handle quoted fields with commas", () => {
    const csv = 'Time,Name\n0,"Smith, John"';
    const result = parseCSV(csv);
    expect(result.rows[0]["Name"]).toBe("Smith, John");
  });

  it("should return empty result for CSV with fewer than 2 lines", () => {
    const result = parseCSV("headers only");
    expect(result.rows).toHaveLength(0);
  });

  it("should detect numeric time column named 'Time'", () => {
    const csv = "Time,RPM\n0,800\n1,850";
    const result = parseCSV(csv);
    expect(result.timeColumn?.type).toBe("seconds");
    expect(result.timeColumn?.key).toBe("Time");
  });

  it("should pivot long-format PID/VALUE CSV to wide format", () => {
    const csv = "Time,PID,VALUE\n0,RPM,800\n0,Coolant,75\n1,RPM,850\n1,Coolant,76";
    const result = parseCSV(csv);
    expect(result.headers).toContain("RPM");
    expect(result.headers).toContain("Coolant");
    expect(result.rows[0]["RPM"]).toBe(800);
  });

  it("should handle European decimal comma values", () => {
    const csv = "Time,Coolant\n0,75,3";  // comma as decimal
    // This tests the isNumeric/toNumber with comma replacement
  });

  it("should map canonical parameters via headerMapping", () => {
    const csv = "Time,Coolant Temp\n0,85";
    const result = parseCSV(csv);
    expect(result.headerMapping["Coolant Temp"]?.canonical_key).toBe("coolant_temp");
  });
});
```

### 2. Insight Engine — `src/lib/insight-engine.ts` (HIGHEST PRIORITY)

The rule evaluation engine determines what diagnostic flags users see. Incorrect rule logic produces false positives or misses real problems. It is pure (no side effects) and straightforward to unit test.

**Functions to test:**
- `evaluateRules(parsed: ParsedCSV, rules: Rule[]): SessionFlag[]`
- `computeParameterSummaries(parsed: ParsedCSV): ParameterSummary[]`

**Test cases to write:**
```typescript
// src/test/insight-engine.test.ts
import { describe, it, expect } from "vitest";
import { evaluateRules, computeParameterSummaries } from "@/lib/insight-engine";
import type { ParsedCSV } from "@/lib/csv-parser";

const makeCSV = (rows: Record<string, number>[], timeKey = "Time"): ParsedCSV => ({
  headers: [timeKey, ...Object.keys(rows[0] || {})],
  rows: rows.map((r, i) => ({ [timeKey]: i, ...r })),
  headerMapping: {
    coolant_temp: { canonical_key: "coolant_temp", label: "Coolant Temp", unit: "°C" },
  },
  timeColumn: { type: "seconds", key: timeKey },
});

const coolantRule = {
  canonical_key: "coolant_temp",
  parameter_key: "coolant_temp",
  label: "Coolant Temp",
  unit: "°C",
  normal_min: 75, normal_max: 105,
  warn_min: null, warn_max: 105,
  critical_min: null, critical_max: 115,
  min_duration_seconds: 30,
  notes: "Attention: coolant high. Critical: critical coolant.",
};

describe("evaluateRules", () => {
  it("should return no flags when all values are in normal range", () => {
    const parsed = makeCSV(Array(60).fill(null).map(() => ({ coolant_temp: 90 })));
    const flags = evaluateRules(parsed, [coolantRule]);
    expect(flags).toHaveLength(0);
  });

  it("should flag 'attention' when warn threshold exceeded for sufficient duration", () => {
    // 60 rows at 1s each = 60s > min_duration_seconds(30)
    const parsed = makeCSV(Array(60).fill(null).map(() => ({ coolant_temp: 110 })));
    const flags = evaluateRules(parsed, [coolantRule]);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe("attention");
  });

  it("should flag 'critical' when critical threshold exceeded for sufficient duration", () => {
    const parsed = makeCSV(Array(60).fill(null).map(() => ({ coolant_temp: 120 })));
    const flags = evaluateRules(parsed, [coolantRule]);
    expect(flags[0].severity).toBe("critical");
  });

  it("should not double-flag critical as both critical and attention", () => {
    const parsed = makeCSV(Array(60).fill(null).map(() => ({ coolant_temp: 120 })));
    const flags = evaluateRules(parsed, [coolantRule]);
    expect(flags).toHaveLength(1);
  });

  it("should not flag attention when streak is shorter than min_duration_seconds", () => {
    // Only 5 rows at 1s each = 5s < min_duration_seconds(30)
    const parsed = makeCSV(Array(5).fill(null).map(() => ({ coolant_temp: 110 })));
    const flags = evaluateRules(parsed, [coolantRule]);
    expect(flags).toHaveLength(0);
  });

  it("should skip rule if no matching column in headerMapping", () => {
    const parsed = makeCSV(Array(60).fill(null).map(() => ({ engine_rpm: 3000 })));
    const flags = evaluateRules(parsed, [coolantRule]); // coolant rule, but no coolant data
    expect(flags).toHaveLength(0);
  });
});

describe("computeParameterSummaries", () => {
  it("should compute min, max, avg, median for a parameter", () => {
    const parsed = makeCSV([
      { coolant_temp: 80 }, { coolant_temp: 90 }, { coolant_temp: 100 },
    ]);
    const summaries = computeParameterSummaries(parsed);
    const coolant = summaries.find(s => s.canonical_key === "coolant_temp");
    expect(coolant?.min).toBe(80);
    expect(coolant?.max).toBe(100);
    expect(coolant?.avg).toBeCloseTo(90);
    expect(coolant?.median).toBe(90);
  });

  it("should skip the time column", () => {
    const parsed = makeCSV([{ coolant_temp: 85 }]);
    const summaries = computeParameterSummaries(parsed);
    expect(summaries.find(s => s.parameter_key === "Time")).toBeUndefined();
  });
});
```

### 3. Canonical Parameter Matching — `src/lib/canonical-params.ts` (HIGH PRIORITY)

Header matching determines whether OBD2 CSV columns are recognized and mapped. Missed mappings mean rules don't fire and summaries use raw keys.

```typescript
// src/test/canonical-params.test.ts
import { describe, it, expect } from "vitest";
import { matchCanonicalKey } from "@/lib/canonical-params";

describe("matchCanonicalKey", () => {
  it("should match 'Coolant Temp' to coolant_temp", () => {
    expect(matchCanonicalKey("Coolant Temp")?.canonical_key).toBe("coolant_temp");
  });

  it("should match case-insensitively", () => {
    expect(matchCanonicalKey("ENGINE RPM")?.canonical_key).toBe("engine_rpm");
  });

  it("should match by OBD2 PID hex code substring", () => {
    expect(matchCanonicalKey("0x05")?.canonical_key).toBe("coolant_temp");
  });

  it("should return null for unrecognized headers", () => {
    expect(matchCanonicalKey("SomeUnknownParam")).toBeNull();
  });
});
```

### 4. Chat Type Helpers — `src/lib/chat/types.ts` (MEDIUM PRIORITY)

Pure helper functions with no dependencies — easiest tests to write.

```typescript
// src/test/chat-types.test.ts
import { describe, it, expect } from "vitest";
import { getMessageText, createTextMessage } from "@/lib/chat/types";

describe("getMessageText", () => {
  it("should extract text from text parts", () => {
    const msg = createTextMessage("user", "Hello");
    expect(getMessageText(msg)).toBe("Hello");
  });

  it("should join multiple text parts with newline", () => {
    const msg = { id: "1", role: "user" as const, parts: [
      { type: "text" as const, text: "A" },
      { type: "text" as const, text: "B" },
    ], attachments: [], createdAt: "" };
    expect(getMessageText(msg)).toBe("A\nB");
  });
});
```

### 5. Car Hook — `src/hooks/use-cars.ts` (MEDIUM PRIORITY)

Tests require mocking Supabase and localStorage. Use `renderHook` from `@testing-library/react`.

```typescript
// src/test/use-cars.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCars } from "@/hooks/use-cars";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { /* mock */ } }));
vi.mock("@/lib/db", () => ({
  getUserCars: vi.fn().mockResolvedValue([]),
  createCarProfile: vi.fn(),
  updateCarProfile: vi.fn(),
  deleteCarProfile: vi.fn(),
}));

describe("useCars", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should start with loading: true then resolve", async () => {
    const { result } = renderHook(() => useCars());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("should auto-select first car when none selected", async () => {
    const { getUserCars } = await import("@/lib/db");
    vi.mocked(getUserCars).mockResolvedValue([{ id: "car-1", name: "Prius", notes: null, created_at: "" }]);
    const { result } = renderHook(() => useCars());
    await waitFor(() => expect(result.current.selectedCarId).toBe("car-1"));
  });
});
```

## Critical Testing Gaps (Prioritized)

### HIGHEST PRIORITY — Data correctness

| Area | File | What is missing | Impact |
|---|---|---|---|
| CSV parsing | `src/lib/csv-parser.ts` | All parsing paths untested | Corrupt/missing data silently |
| Insight engine rules | `src/lib/insight-engine.ts` | No rule evaluation tests | Wrong flags shown to users |
| Canonical matching | `src/lib/canonical-params.ts` | No keyword matching tests | Parameters not recognized |

### HIGH PRIORITY — Core user flows

| Area | File | What is missing | Impact |
|---|---|---|---|
| CSV upload orchestration | `src/hooks/use-csv-upload.ts` | Multi-step pipeline untested | Data loss on upload errors |
| Car management hook | `src/hooks/use-cars.ts` | State management untested | Car selection/persistence bugs |
| DB layer | `src/lib/db.ts` | All Supabase calls untested | Silent data errors |

### MEDIUM PRIORITY — Application features

| Area | Files | What is missing | Impact |
|---|---|---|---|
| Chat type helpers | `src/lib/chat/types.ts` | No tests for pure helpers | Message format bugs |
| Chat DB operations | `src/lib/chat/db.ts` | No tests for CRUD | Conversation data loss |
| Gemini response parsing | `src/lib/gemini-service.ts` | `parseGeminiResponse` untested | AI results lost on parse error |
| Auth context | `src/contexts/AuthContext.tsx` | No tests for auth state | Session handling bugs |

### LOW PRIORITY — UI components

| Area | Files | What is missing |
|---|---|---|
| FlagsPanel rendering | `src/components/FlagsPanel.tsx` | No render tests |
| PrivateRoute redirect | `src/components/PrivateRoute.tsx` | No auth guard tests |
| AppLayout structure | `src/components/AppLayout.tsx` | No layout tests |

## RLS Data Isolation — Not Testable in Unit Tests

Row-Level Security isolation (each user only sees their own cars/sessions) is enforced by Supabase RLS policies in the database, not in application code. This **cannot be tested** with Vitest unit tests because:
- Unit tests mock the Supabase client — RLS policies never execute
- The DB layer functions (`getUserCars`, `getSessions`, etc.) make no user-filter calls; RLS enforces isolation server-side

**To verify RLS isolation**, write Supabase integration tests using the Supabase test helpers or pg-tap, or test manually with two accounts.

## No Integration or E2E Tests

- No Playwright or Cypress installed
- No Supabase integration test harness (`supabase/tests/` not present)
- Full upload flow (file selection → parse → DB write → flag display) is tested only by manual QA

## Fixtures Needed Before Writing Tests

Create `src/test/fixtures/` with:

**`src/test/fixtures/parsed-csv.ts`** — factory for `ParsedCSV` objects:
```typescript
export function makeParsedCSV(overrides?: Partial<ParsedCSV>): ParsedCSV {
  return {
    headers: ["Time", "coolant_temp"],
    rows: [{ Time: 0, coolant_temp: 85 }, { Time: 1, coolant_temp: 86 }],
    headerMapping: { coolant_temp: { canonical_key: "coolant_temp", label: "Coolant Temp", unit: "°C" } },
    timeColumn: { type: "seconds", key: "Time" },
    ...overrides,
  };
}
```

**`src/test/fixtures/cars.ts`** — factory for `CarProfile`:
```typescript
export function makeCarProfile(overrides?: Partial<CarProfile>): CarProfile {
  return { id: "car-1", name: "Test Car", notes: null, created_at: new Date().toISOString(), ...overrides };
}
```

## Additional Setup Required

Before writing component/hook tests, add to `src/test/setup.ts`:

```typescript
// localStorage mock (use-cars.ts depends on it)
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// crypto.randomUUID (chat and upload use it)
Object.defineProperty(global, "crypto", {
  value: { randomUUID: () => "test-uuid-" + Math.random() },
});

// URL object methods (CSV download uses these)
global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
global.URL.revokeObjectURL = vi.fn();
```

---

*Testing analysis: 2026-05-17*
