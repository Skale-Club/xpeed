# Architecture

**Analysis Date:** 2026-05-17

## Pattern Overview

**Overall:** Feature-oriented SPA with layered separation — Context providers → custom hooks → service layer → Supabase. No custom backend server exists; all logic runs in the browser.

**Key Characteristics:**
- Single-page React 18 app with client-side routing via `react-router-dom`. No SSR.
- Three global React contexts own global state. Page-local state lives in pages and components directly.
- Supabase handles auth, Postgres storage with RLS, and file storage. Zero custom API layer.
- AI (Google Gemini) is called directly from the browser using the user's own API key stored in the `app_settings` Supabase table. No backend proxy.
- Route-level code splitting via `React.lazy` + `Suspense`.

---

## Layers

### Provider / Root Layer
- Purpose: Install global dependencies and define routing.
- Location: `src/App.tsx`
- Contains: `QueryClientProvider`, `AuthProvider`, `SettingsProvider`, `BrowserRouter`, route definitions, Vercel `Analytics`.
- `AuthenticatedLayout` composes `PrivateRoute` + `CarsProvider` + `Suspense` for all protected routes. `CarsContext` is only mounted inside this wrapper (not for public routes).

### Context / Global State Layer
- Purpose: Share global state across the component tree without prop-drilling.
- Location: `src/contexts/`
- `AuthContext.tsx` — owns `user`, `session`, `loading`. Subscribes to `supabase.auth.onAuthStateChange`. Provides `signIn`, `signInWithGoogle`, `signUp`, `signOut`, `resetPassword`.
- `CarsContext.tsx` — thin wrapper that delegates entirely to `useCars` hook and exposes its return value as context. Provides `cars[]`, `selectedCar`, `selectedCarId`, CRUD actions, `refresh`.
- `SettingsContext.tsx` — owns `distanceUnit` (`km` | `mi`) and `timezone`. Persisted to `localStorage`. No Supabase interaction.

### Custom Hook Layer
- Purpose: Encapsulate async state machines and reusable logic that spans multiple components.
- Location: `src/hooks/`
- `use-cars.ts` — manages car list state. Calls `getUserCars()`, persists `selected_car_id` to `localStorage`, auto-selects first car when selection is absent or invalid.
- `use-csv-upload.ts` — orchestrates the complete CSV ingestion pipeline (see Data Flow). Exposes `upload(file, customName?)`, `uploading`, `progressLabel`, `progressValue`.
- `use-toast.ts` — re-export of shadcn toast hook.
- `use-mobile.tsx` — responsive breakpoint detection.

### Service / Data Access Layer
- Purpose: All Supabase queries are isolated here as named async functions. Components never call `supabase.from()` directly.
- `src/lib/db.ts` — sessions, car profiles, flags, rows, storage (CSV upload/download/delete), Gemini API key and model CRUD, `gemini_analysis` update.
- `src/lib/chat/db.ts` — conversation CRUD (`getConversations`, `createConversation`, `updateConversationTitle`, `deleteConversation`), message CRUD (`getMessages`, `saveMessage`, `deleteMessagesFrom`), `buildChatContext` (assembles vehicle + session summary for AI prompt).
- `src/integrations/supabase/client.ts` — singleton `supabase` client created with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Auth session persisted in `localStorage`.

### Domain Logic Layer
- Purpose: Pure functions for CSV processing, parameter normalization, and rule evaluation. No Supabase dependency; fully testable in isolation.
- Location: `src/lib/`
- `csv-parser.ts` — `parseCSV(text)`: detects delimiter (`,` or `;`), detects time column (ISO timestamp vs. numeric seconds), handles **long-format** PID/VALUE CSVs by pivoting to wide format. Returns `ParsedCSV` with `headers`, `rows`, `headerMapping`, `timeColumn`.
- `canonical-params.ts` — maps raw OBD2 column names to canonical keys (e.g., `vehicle_speed`, `coolant_temp`, `engine_rpm`).
- `insight-engine.ts` — `computeParameterSummaries(parsed)` returns min/max/avg/median per parameter. `evaluateRules(parsed, rules)` scans each parameter's timeseries for critical and attention threshold breaches, counting consecutive streak durations to avoid false positives. Returns `SessionFlag[]`.
- `default-rules.ts` — hardcoded rule set targeting Toyota Prius parameters. Applied during upload and re-compute in `SessionDetail`.
- `gemini-service.ts` — `analyzeSession(apiKey, data, model)` sends structured OBD2 data (summaries + flags) to Gemini, expects JSON response parsed into `GeminiAnalysis`. `validateApiKey()` sends a test prompt. `chatWithVehicleData()` exists but is not used by `ChatContainer` (it re-implements the call inline).

### AI Integration Layer (Gemini)
- Purpose: Browser-side calls to `@google/generative-ai`; user provides their own key.
- Two usage modes:

  **1. Upload-time analysis** (automatic, optional):
  - `use-csv-upload.ts` dynamically imports `gemini-service.ts#analyzeSession` after rows are saved.
  - Result (`GeminiAnalysis` JSON) is written back to `sessions.gemini_analysis` via `updateSessionWithGeminiAnalysis()`.
  - Silently skipped if no API key is configured.
  - Displayed in `SessionDetail` via `AIAnalysisCard`.

  **2. Interactive chat** (user-initiated):
  - `ChatContainer.tsx` instantiates `GoogleGenerativeAI` directly inline (does NOT use `gemini-service.ts`).
  - Builds conversation history from the last 10 local messages.
  - System prompt is injected as the first user/model turn in the history array.
  - Each turn is persisted to `chat_conversations` + `chat_messages` in Supabase.

### Page Layer
- Purpose: Route-level components that fetch data and compose feature components.
- Location: `src/pages/`
- Pages call `src/lib/db.ts` functions directly via `useEffect` + local `useState`. They consume `useCarsContext()` and `useSettings()` from context.
- All lazy-loaded; split at route boundary via `React.lazy`.

### Component Layer
- Purpose: Presentational and composite UI components.
- Location: `src/components/` (feature) and `src/components/ui/` (shadcn/ui primitives).
- `AppLayout.tsx` — the authenticated shell: sticky header with logo + car selector dropdown + nav + user menu + `ChatBubble`. Every protected page is children of this layout.
- `ChatBubble.tsx` — floating action button that toggles `ChatContainer` with local boolean `isOpen` state. Mounted inside `AppLayout`.
- Chat sub-tree (`src/components/chat/`): self-contained, see Chat Architecture below.

---

## Data Flow

### CSV Upload Pipeline

```
UploadCard (drop/select file)
  → useCSVUpload#upload(file, customName?)
      1. file.text()                          — read raw text
      2. parseCSV(text)                       — returns ParsedCSV
      3. computeParameterSummaries(parsed)    — min/max/avg/median per column
      4. evaluateRules(parsed, DEFAULT_PRIUS_RULES) — produces SessionFlag[]
      5. uploadSessionCSV(file, carProfileId) → Storage bucket: session-csv
      6. createSession(...)                   → sessions table (includes source_csv text)
      7. insertSessionRows(sessionId, rows)   → session_rows (200 rows/batch)
      8. insertSessionFlags(sessionId, flags) → session_flags
      9. analyzeSession(apiKey, data)         → Gemini API (optional)
     10. updateSessionWithGeminiAnalysis()    → sessions.gemini_analysis
     11. onComplete(session.id)               → navigate('/session/{id}')
```

On error after step 6: `deleteSession(createdSessionId)` rolls back. On error after step 5 but before 6: `removeSessionCSV(sourceFilePath)` cleans up storage.

### Dashboard Data Flow

```
Index.tsx mounts
  → getSessions(selectedCarId)         → allSessions[]
  → useMemo filter by dateRange        → filteredSessions[]
  → useEffect: per-session flag fetch  → getSessionFlags(id) × up to 20
                                       → trendData[], healthScore, stats
  → useEffect: getFlagsForSessions()   → all flags for GeneralInfoCard
  → DashboardCharts(sessions)          → Recharts visualizations
```

### Chat Architecture and Data Flow

```
AppLayout renders <ChatBubble />
  ChatBubble state: isOpen (boolean)
    → <ChatContainer isOpen onClose />

ChatContainer state:
  conversations[]         ← getConversations()        (on open)
  currentConversation     ← user selection or new
  messages[]              ← getMessages(conv.id)       (on conv change)
  contextData             ← buildChatContext(car.id)   (on open/car change)
  apiKey                  ← getGeminiApiKey()          (on mount)
  modelName               ← getGeminiModel()           (on mount)

handleSendMessage(text):
  1. Optimistic append to messages[]
  2. createConversation(title, carId)    — if no current conversation
  3. saveMessage(convId, 'user', parts)  → chat_messages
  4. new GoogleGenerativeAI(apiKey)
     model.startChat({ history: [systemPrompt turn, ...last 10 msgs] })
     chat.sendMessage(text)
  5. saveMessage(convId, 'assistant', parts) → chat_messages
  6. Append assistant message to messages[]

ChatSidebar  ← conversations[], onSelectConversation
MessageList  ← messages[]
ChatInput    ← input, onSend
```

**Chat context structure** (`ChatContext` type from `src/lib/chat/types.ts`):
```typescript
{
  vehicle: { name: string; notes: string | null } | null,
  recentSessions: Array<{ date, filename, duration, summary }>,  // last 5
  sessionCount: number
}
```

### Auth Flow

```
App boots → AuthProvider mounts
  supabase.auth.getSession()        → sets user/session/loading
  supabase.auth.onAuthStateChange() → subscription for updates

Route access → PrivateRoute checks user
  user === null + loading === false → <Navigate to="/login" />
  user !== null                    → render children

Sign in (email) → supabase.auth.signInWithPassword()
Sign in (Google) → supabase.auth.signInWithOAuth({ provider: 'google' })
  redirectTo: VITE_APP_URL (canonical) or window.location.origin
  callback returns to app root → onAuthStateChange fires → user set
```

---

## State Management

**Global state** via three React contexts:

| Context | State Owned | Persistence |
|---|---|---|
| `AuthContext` | `user`, `session`, `loading` | Supabase `localStorage` session |
| `CarsContext` | `cars[]`, `selectedCarId`, `loading`, `error` | `localStorage` key `selected_car_id` |
| `SettingsContext` | `distanceUnit`, `timezone` | `localStorage` keys `settings_distanceUnit`, `settings_timezone` |

**Server state** (sessions, flags, rows) is fetched on-demand by pages using `useEffect` + local `useState`. `@tanstack/react-query` is installed and `QueryClientProvider` is mounted in `App.tsx`, but it is **not actively used** for any data fetching — it is available for future adoption.

**Chat state** is local to `ChatContainer.tsx`. It is not shared via context.

---

## Database Schema (Supabase / Postgres)

All tables have RLS enabled. Ownership enforced via `user_id = auth.uid()`. Sub-tables (`session_rows`, `session_flags`) inherit ownership via sub-select through parent session's `user_id`.

| Table | Key Columns | Notes |
|---|---|---|
| `car_profiles` | `id`, `name`, `notes`, `user_id`, `is_admin` | `user_id` auto-set by `set_user_id()` trigger on INSERT |
| `sessions` | `id`, `car_profile_id`, `source_filename`, `source_file_path`, `source_csv` (TEXT), `summary` (JSONB), `gemini_analysis` (JSONB), `user_id` | `source_csv` is raw CSV text fallback when Storage unavailable |
| `session_rows` | `id`, `session_id`, `t_seconds`, `t_timestamp`, `data` (JSONB) | Read capped at 1000 rows; index on `session_id` |
| `session_flags` | `id`, `session_id`, `severity`, `canonical_key`, `parameter_key`, `message`, `evidence` (JSONB), `resolved` (BOOL) | `resolved` added in migration `20260209182800` |
| `parameter_rules` | `id`, `car_profile_id`, `canonical_key`, thresholds... | Schema exists but not queried at runtime; `DEFAULT_PRIUS_RULES` used instead |
| `app_settings` | `id`, `setting_key`, `setting_value`, `user_id` | Unique constraint on `(setting_key, user_id)`; stores `gemini_api_key` and `gemini_model` |
| `chat_conversations` | `id`, `title`, `user_id`, `car_profile_id`, `updated_at` | `updated_at` auto-bumped by trigger when a message is inserted |
| `chat_messages` | `id`, `conversation_id`, `role`, `parts` (JSONB), `attachments` (JSONB) | Parts: `[{ type: 'text', text: '...' }]` compatible with Vercel AI SDK format |

**Storage bucket:** `session-csv`. Path pattern: `{userId}/{carProfileId}/{timestamp}-{uuid}-{sanitizedFilename}`.

---

## Entry Points

**App bootstrap:**
- `src/main.tsx` — mounts `<App />` into `#root`.
- `src/App.tsx` — installs all providers and route tree.

**Protected route shell:**
- `src/components/AppLayout.tsx` — header, nav, footer, `ChatBubble`. All authenticated pages are children of this.

**Route guard:**
- `src/components/PrivateRoute.tsx` — checks `useAuth().user`; shows spinner during auth loading, redirects to `/login` if unauthenticated.

**CSV ingestion:**
- `src/hooks/use-csv-upload.ts#upload()` — sole entry point for the entire CSV → session pipeline.

**Chat entry:**
- `src/components/ChatBubble.tsx` — always rendered inside `AppLayout`, toggles `ChatContainer`.

**Supabase client:**
- `src/integrations/supabase/client.ts` — singleton; imported as `import { supabase } from '@/integrations/supabase/client'`.

---

## Error Handling

**Strategy:** Service functions throw on error; hooks and components catch with toast notifications.

**Patterns:**
- `src/lib/db.ts` — every function throws `new Error(error.message)` when Supabase returns an error object.
- `use-csv-upload.ts` — try/catch/finally around the full pipeline. Rollback logic: if `createdSessionId` exists → `deleteSession()`; else if `sourceFilePath` exists → `removeSessionCSV()`.
- `ChatContainer.tsx` — catches Gemini errors, shows destructive toast, removes the optimistically-added user message.
- `gemini-service.ts#parseGeminiResponse()` — falls back to returning raw text as `summary` if JSON parsing fails.
- `AuthContext` — methods throw; callers in page components catch and show toasts.

---

## Cross-Cutting Concerns

**Logging:** `console.error` / `console.warn` inline. No structured logging library.

**Validation:** Client-side only. Empty CSV check in `useCSVUpload`. No schema validation library (no Zod).

**Authentication:** `PrivateRoute` enforces auth at route level. Supabase RLS enforces at database level. No middleware exists between client and database.

**Toasts:** Two toast systems coexist — `useToast` hook (radix-based, used in most hooks/components) and `sonner` `toast.success/error()` (used inline in `Index.tsx`). Both are mounted in `App.tsx`.

**Unit conversion:** Distance and fuel efficiency conversions are computed inline in `Index.tsx` and `LatestTripCard.tsx` using `useSettings().distanceUnit`. No centralized conversion utility.

---

*Architecture analysis: 2026-05-17*
