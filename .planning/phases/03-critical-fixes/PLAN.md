---
phase: 03-critical-fixes
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/db.ts
  - src/lib/crypto.ts
  - src/contexts/AuthContext.tsx
  - src/vite-env.d.ts
  - src/pages/SettingsPage.tsx
  - src/pages/Index.tsx
  - src/pages/HistoryPage.tsx
  - src/components/DashboardCharts.tsx
  - src/types/session.ts
  - supabase/migrations/20260517_api_key_encryption.sql
  - supabase/migrations/20260517_chat_user_id_trigger.sql
  - supabase/migrations/20260517_session_start_not_null.sql
autonomous: true
requirements:
  - SEC-01
  - SEC-02
  - SEC-03
  - SEC-04
  - TS-01
  - TS-02
  - DB-01

must_haves:
  truths:
    - "Gemini API keys are never stored as plaintext in the database"
    - "Auth loading state resolves only after onAuthStateChange fires, eliminating the race window"
    - "Google OAuth never silently falls back to window.location.origin in production"
    - "chat_conversations INSERT auto-sets user_id via trigger, identical to car_profiles behavior"
    - "session_start column is NOT NULL with a default, removing the null-fallback in filter logic"
    - "No bare `any` type annotations remain in the five flagged files"
    - "No @ts-ignore comment remains in SettingsPage.tsx"
  artifacts:
    - path: "src/lib/crypto.ts"
      provides: "AES-256-GCM encrypt/decrypt helpers using Web Crypto API"
      exports: ["encryptApiKey", "decryptApiKey"]
    - path: "src/types/session.ts"
      provides: "SessionRow, SessionFlag, SessionSummaryItem interfaces"
      exports: ["SessionRow", "SessionFlag", "SessionSummaryItem", "DashboardSession"]
    - path: "supabase/migrations/20260517_api_key_encryption.sql"
      provides: "Re-encrypts existing plaintext keys; adds encrypted column"
      contains: "ALTER TABLE app_settings"
    - path: "supabase/migrations/20260517_chat_user_id_trigger.sql"
      provides: "set_user_id trigger on chat_conversations INSERT"
      contains: "CREATE TRIGGER set_chat_conversations_user_id"
    - path: "supabase/migrations/20260517_session_start_not_null.sql"
      provides: "session_start default + NOT NULL backfill"
      contains: "ALTER TABLE sessions"
  key_links:
    - from: "src/lib/db.ts:saveGeminiApiKey"
      to: "src/lib/crypto.ts:encryptApiKey"
      via: "import and call before upsert"
      pattern: "encryptApiKey\\(apiKey"
    - from: "src/lib/db.ts:getGeminiApiKey"
      to: "src/lib/crypto.ts:decryptApiKey"
      via: "decrypt after select before return"
      pattern: "decryptApiKey\\(data"
    - from: "src/contexts/AuthContext.tsx"
      to: "onAuthStateChange"
      via: "setLoading(false) inside the callback, not in getSession().then()"
      pattern: "onAuthStateChange.*setLoading"
---

<objective>
Fix all HIGH and CRITICAL security vulnerabilities and type-safety issues identified in the
pre-production codebase audit. No new features. No refactors beyond the scope of each fix.

Purpose: The app must not reach real users with a plaintext API key store, an auth race that
can briefly expose protected routes, or an OAuth redirect that silently points to the wrong
origin.

Output: Encrypted Gemini key storage, corrected auth loading order, hardened OAuth URL,
chat conversation user_id trigger, session_start NOT NULL migration, typed interfaces
replacing `any` in the five flagged files, and a proper Intl type declaration.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@src/lib/db.ts
@src/lib/crypto.ts
@src/contexts/AuthContext.tsx
@src/pages/SettingsPage.tsx
@src/pages/Index.tsx
@src/pages/HistoryPage.tsx
@src/components/DashboardCharts.tsx
@src/vite-env.d.ts
@supabase/migrations/20260308_chat_system.sql
@supabase/migrations/20260209104400_multi_car_support.sql

<interfaces>
<!-- Existing types the executor must NOT duplicate -->

From src/lib/chat/types.ts:
```typescript
export interface ChatMessage { id, role, parts, attachments, createdAt }
export interface ChatConversation { id, title, user_id, car_profile_id, created_at, updated_at }
```

From src/lib/db.ts (SESSION_LIST_SELECT columns — these become SessionRow fields):
  id, car_profile_id, uploaded_at, source_filename, source_file_path,
  session_start, session_end, duration_seconds, row_count, columns,
  summary, created_at, user_id, gemini_analysis

From supabase/migrations/20260209104400_multi_car_support.sql:
```sql
-- Reference trigger pattern to replicate for chat:
CREATE OR REPLACE FUNCTION public.set_user_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.user_id = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```
</interfaces>
</context>

<tasks>

<!-- ============================================================ -->
<!-- TASK 1 — CRITICAL: Encrypt Gemini API key at rest           -->
<!-- ============================================================ -->
<task type="auto">
  <name>Task 1: Encrypt Gemini API key storage (CRITICAL)</name>
  <files>
    src/lib/crypto.ts
    src/lib/db.ts
    supabase/migrations/20260517_api_key_encryption.sql
  </files>
  <action>
    **Step 1 — Create `src/lib/crypto.ts`**

    Implement AES-256-GCM encrypt/decrypt using the browser's built-in Web Crypto API
    (no external dependency). The encryption key is derived from two inputs XORed together:
    the Supabase JWT (user-session-bound, read from `supabase.auth.getSession()`) and the
    env var `VITE_ENCRYPTION_SALT` (a static 32-byte hex string set at build time).
    This gives user-specific encryption without a dedicated KMS.

    ```typescript
    // src/lib/crypto.ts

    const SALT = import.meta.env.VITE_ENCRYPTION_SALT;

    // Derives a CryptoKey from the user's JWT + static salt.
    // Call once per encrypt/decrypt operation — do NOT cache the key across sessions.
    async function deriveKey(jwtToken: string): Promise<CryptoKey> {
      const encoder = new TextEncoder();
      const raw = encoder.encode(jwtToken + SALT);
      const keyMaterial = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: encoder.encode(SALT), iterations: 100_000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    }

    export async function encryptApiKey(plaintext: string, jwtToken: string): Promise<string> {
      const key = await deriveKey(jwtToken);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
      // Store as base64(iv):base64(ciphertext)
      const toBase64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
      return `${toBase64(iv)}:${toBase64(ciphertext)}`;
    }

    export async function decryptApiKey(encrypted: string, jwtToken: string): Promise<string> {
      const [ivB64, ciphertextB64] = encrypted.split(':');
      const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const key = await deriveKey(jwtToken);
      const dec = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(ivB64) },
        key,
        fromBase64(ciphertextB64),
      );
      return new TextDecoder().decode(dec);
    }
    ```

    Add a dev-time guard at the top of the file (after the SALT line):
    ```typescript
    if (!SALT && import.meta.env.DEV) {
      console.warn('[crypto] VITE_ENCRYPTION_SALT is not set. API key encryption will be weak.');
    }
    ```

    **Step 2 — Update `src/lib/db.ts`**

    In `saveGeminiApiKey()` (lines 327-345):
    - Import `encryptApiKey` from `@/lib/crypto`
    - After authenticating the user, call `supabase.auth.getSession()` to get the JWT
      (`data.session?.access_token`)
    - Encrypt `apiKey` before the upsert: `const encrypted = await encryptApiKey(apiKey, jwt)`
    - Set `setting_value: encrypted` and `encrypted: true` in the upsert payload

    In `getGeminiApiKey()` (lines 317-324):
    - Import `decryptApiKey` from `@/lib/crypto`
    - Also select `encrypted` column: `.select('setting_value, encrypted')`
    - After fetch: if `data?.encrypted` is true, call `decryptApiKey(data.setting_value, jwt)`
      to return the plaintext key; if `encrypted` is false (legacy row), return raw value and
      log a migration warning in dev mode
    - Fetch the JWT the same way (getSession → access_token) before decrypting

    **Step 3 — Create migration `supabase/migrations/20260517_api_key_encryption.sql`**

    The migration only concerns the DB schema — it does NOT attempt to encrypt existing
    plaintext rows (that would require the user's JWT which the DB doesn't have). Instead:
    - Ensure the `encrypted` column exists and defaults to false (it already does per code)
    - Add a comment documenting that existing rows with `encrypted = false` will be
      re-encrypted by the application on next save
    - Optionally: add a CHECK constraint so `encrypted` must be true for
      `setting_key = 'gemini_api_key'` going forward (makes the schema self-documenting)

    ```sql
    -- 20260517_api_key_encryption.sql
    -- Enforce that gemini_api_key rows are always marked encrypted.
    -- Existing plaintext rows (encrypted = false) are migrated on next user save.

    ALTER TABLE public.app_settings
      ADD CONSTRAINT chk_gemini_key_encrypted
      CHECK (
        setting_key <> 'gemini_api_key' OR encrypted = true
      )
      NOT VALID; -- NOT VALID skips existing rows; new inserts must comply
    ```

    **What NOT to do:**
    - Do NOT use a single static app-wide key (that is equivalent to no encryption)
    - Do NOT store VITE_ENCRYPTION_SALT in the DB or in any client-readable location
    - Do NOT add a Supabase Edge Function unless the user decides to refactor the whole
      key-management flow later (out of scope here)
  </action>
  <verify>
    <automated>cd C:/Users/Vanildo/Dev/car-insights-ai && npx tsc --noEmit 2>&1 | grep -E "crypto|db\.ts" || echo "No type errors in crypto/db"</automated>
  </verify>
  <done>
    - `src/lib/crypto.ts` exists and exports `encryptApiKey` and `decryptApiKey`
    - `saveGeminiApiKey` in `db.ts` calls `encryptApiKey` and stores `encrypted: true`
    - `getGeminiApiKey` in `db.ts` calls `decryptApiKey` when `encrypted = true`
    - Migration file exists with `NOT VALID` CHECK constraint
    - `npx tsc --noEmit` reports zero errors in the changed files
  </done>
</task>

<!-- ============================================================ -->
<!-- TASK 2 — HIGH: Auth race + OAuth URL hardening              -->
<!-- ============================================================ -->
<task type="auto">
  <name>Task 2: Fix auth loading race and OAuth redirect fallback (HIGH)</name>
  <files>
    src/contexts/AuthContext.tsx
  </files>
  <action>
    **Fix 1 — Auth race condition (lines 23-38)**

    Current code sets `loading = false` inside `getSession().then()`, which fires before
    `onAuthStateChange` can emit. Any component that reads `loading` can briefly see
    `loading = false` with stale (or missing) session state.

    Replace the useEffect body with this pattern — the loading gate moves into the
    `onAuthStateChange` callback so it only drops after the authoritative auth event:

    ```typescript
    useEffect(() => {
      // Track whether onAuthStateChange has fired at least once.
      // We still call getSession() to populate state quickly, but we do NOT
      // set loading=false here — only the subscription callback does that.
      let initialized = false;

      supabase.auth.getSession().then(({ data: { session } }) => {
        // Optimistic population — may be overwritten by the subscription below.
        // Do NOT setLoading(false) here.
        setSession(session);
        setUser(session?.user ?? null);
      });

      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        if (!initialized) {
          initialized = true;
          setLoading(false); // Only drops the gate after the authoritative event fires
        }
      });

      return () => subscription.unsubscribe();
    }, []);
    ```

    **Fix 2 — OAuth redirect URL (lines 50-51)**

    The silent fallback `appUrl || window.location.origin` means a misconfigured
    production deploy will use the preview URL as the OAuth callback, causing a CSRF
    surface and confusing auth failures.

    Replace the `signInWithGoogle` body:

    ```typescript
    const signInWithGoogle = async () => {
      const appUrl = import.meta.env.VITE_APP_URL?.replace(/\/$/, '');

      if (!appUrl) {
        if (import.meta.env.DEV) {
          console.warn(
            '[AuthContext] VITE_APP_URL is not set. ' +
            'Falling back to window.location.origin for OAuth redirect. ' +
            'Set VITE_APP_URL in production to avoid auth issues.'
          );
        } else {
          // In production, a missing VITE_APP_URL is a deployment error — fail loudly.
          throw new Error(
            'OAuth redirect URL is not configured. Set VITE_APP_URL in environment variables.'
          );
        }
      }

      const redirectTo = appUrl ?? window.location.origin;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (error) {
        console.error('Google OAuth error:', error.message);
        throw error;
      }
    };
    ```

    **Also fix the `any` on line 11 (AuthContextType.signUp return)**

    Change:
    ```typescript
    signUp: (email: string, password: string) => Promise<{ data: { user: User | null; session: Session | null }; error: any }>;
    ```
    To:
    ```typescript
    import type { AuthError } from '@supabase/supabase-js';
    // ...
    signUp: (email: string, password: string) => Promise<{ data: { user: User | null; session: Session | null }; error: AuthError | null }>;
    ```
    Add the `AuthError` to the existing import from `@supabase/supabase-js` at line 3.
  </action>
  <verify>
    <automated>cd C:/Users/Vanildo/Dev/car-insights-ai && npx tsc --noEmit 2>&1 | grep "AuthContext" || echo "No type errors in AuthContext"</automated>
  </verify>
  <done>
    - `loading` initializes as `true` and is set to `false` only inside `onAuthStateChange`
    - `getSession().then()` does NOT call `setLoading(false)`
    - In production (non-DEV), missing `VITE_APP_URL` throws before calling Supabase OAuth
    - In dev, missing `VITE_APP_URL` logs a warning and falls back gracefully
    - `signUp` return type uses `AuthError | null` instead of `any`
    - `npx tsc --noEmit` reports zero errors in AuthContext.tsx
  </done>
</task>

<!-- ============================================================ -->
<!-- TASK 3 — HIGH: Chat user_id trigger + LOW: session_start    -->
<!-- ============================================================ -->
<task type="auto">
  <name>Task 3: Chat conversations user_id trigger and session_start NOT NULL migration (HIGH + LOW)</name>
  <files>
    supabase/migrations/20260517_chat_user_id_trigger.sql
    supabase/migrations/20260517_session_start_not_null.sql
  </files>
  <action>
    **Migration 1 — `supabase/migrations/20260517_chat_user_id_trigger.sql`**

    The `chat_conversations` table has RLS policies that check `user_id = auth.uid()`, but
    there is no trigger that auto-populates `user_id` on INSERT — unlike `car_profiles` and
    `sessions` which both use `public.set_user_id()`. Without the trigger, a client must
    supply `user_id` explicitly or the INSERT returns a RLS violation.

    The `public.set_user_id()` function already exists (created in 20260209104400). Reuse it:

    ```sql
    -- 20260517_chat_user_id_trigger.sql
    -- Add auto-set user_id trigger to chat_conversations,
    -- matching the pattern used by car_profiles and sessions.

    DROP TRIGGER IF EXISTS set_chat_conversations_user_id ON public.chat_conversations;

    CREATE TRIGGER set_chat_conversations_user_id
      BEFORE INSERT ON public.chat_conversations
      FOR EACH ROW
      EXECUTE FUNCTION public.set_user_id();
    ```

    No new function needed — `public.set_user_id()` is already SECURITY DEFINER and sets
    `NEW.user_id = auth.uid()`.

    **Migration 2 — `supabase/migrations/20260517_session_start_not_null.sql`**

    `Index.tsx:69` uses `s.session_start || s.uploaded_at` because `session_start` can be
    NULL. The fix is to backfill existing NULLs from `uploaded_at` and add a DEFAULT so
    future inserts never produce a NULL `session_start`.

    ```sql
    -- 20260517_session_start_not_null.sql
    -- Backfill NULL session_start values and enforce NOT NULL with a default.

    -- 1. Backfill existing NULLs
    UPDATE public.sessions
    SET session_start = uploaded_at
    WHERE session_start IS NULL;

    -- 2. Set column default so future INSERTs without session_start use uploaded_at
    --    (uploaded_at itself defaults to now(), so this cascades correctly)
    ALTER TABLE public.sessions
      ALTER COLUMN session_start SET DEFAULT now();

    -- 3. Enforce NOT NULL now that all existing rows are populated
    ALTER TABLE public.sessions
      ALTER COLUMN session_start SET NOT NULL;
    ```

    After these migrations are applied, the `|| s.uploaded_at` fallback in `Index.tsx:69`
    and `DashboardCharts.tsx:170` becomes dead code. Leave it in place for this task —
    removing it is part of Task 4 (type cleanup) where those lines are touched anyway.
  </action>
  <verify>
    <automated>ls C:/Users/Vanildo/Dev/car-insights-ai/supabase/migrations/20260517_chat_user_id_trigger.sql C:/Users/Vanildo/Dev/car-insights-ai/supabase/migrations/20260517_session_start_not_null.sql && echo "Both migration files exist"</automated>
  </verify>
  <done>
    - `20260517_chat_user_id_trigger.sql` exists and creates trigger on `chat_conversations`
      using the existing `public.set_user_id()` function
    - `20260517_session_start_not_null.sql` exists with UPDATE backfill, DEFAULT, and NOT NULL
    - Both files contain valid SQL (no syntax errors visible from review)
  </done>
</task>

<!-- ============================================================ -->
<!-- TASK 4 — MEDIUM: TypeScript any cleanup + @ts-ignore fix    -->
<!-- ============================================================ -->
<task type="auto">
  <name>Task 4: Replace `any` types and fix @ts-ignore in SettingsPage (MEDIUM)</name>
  <files>
    src/types/session.ts
    src/pages/Index.tsx
    src/pages/HistoryPage.tsx
    src/components/DashboardCharts.tsx
    src/vite-env.d.ts
    src/pages/SettingsPage.tsx
  </files>
  <action>
    **Step 1 — Create `src/types/session.ts`**

    Create this file with typed interfaces derived from the SESSION_LIST_SELECT columns
    in `db.ts` and from usage patterns in Index.tsx and HistoryPage.tsx:

    ```typescript
    // src/types/session.ts

    export interface SessionSummaryItem {
      canonical_key: string;
      parameter_key: string;
      label: string;
      max: number | null;
      avg: number | null;
      min: number | null;
      unit?: string;
    }

    export interface SessionSummary {
      summaries: SessionSummaryItem[];
    }

    export interface SessionRow {
      id: string;
      car_profile_id: string | null;
      uploaded_at: string;
      source_filename: string | null;
      source_file_path: string | null;
      session_start: string; // NOT NULL after migration
      session_end: string | null;
      duration_seconds: number | null;
      row_count: number | null;
      columns: string[] | null;
      summary: SessionSummary | null;
      created_at: string;
      user_id: string | null;
      gemini_analysis: string | null;
    }

    export interface SessionFlag {
      id: string;
      session_id: string;
      severity: 'attention' | 'critical';
      message: string;
      parameter_key: string | null;
      resolved: boolean;
      created_at: string;
    }

    // Alias used in Index.tsx for the dashboard problem list
    export interface SessionProblem {
      id: string;
      message: string;
      severity: 'attention' | 'critical';
      session_id: string;
      resolved: boolean;
    }
    ```

    **Step 2 — Update `src/pages/Index.tsx`**

    - Add import: `import type { SessionRow, SessionFlag, SessionProblem } from '@/types/session'`
    - Change line 46: `useState<any[]>([])` → `useState<SessionRow[]>([])`
    - Change line 53 `problems: [] as any[]` inside `generalStats` initial state →
      `problems: [] as SessionProblem[]`
    - Remove the `as any[]` cast anywhere else in the file
    - In `filteredSessions` useMemo (line 69), remove the `|| s.uploaded_at` fallback
      since `session_start` is now NOT NULL (leave a comment: `// session_start is NOT NULL per migration 20260517`)

    **Step 3 — Update `src/pages/HistoryPage.tsx`**

    - Add import: `import type { SessionRow, SessionFlag } from '@/types/session'`
    - Line 32: `useState<any[]>([])` → `useState<SessionRow[]>([])`
    - Line 39: `useState<any>(null)` → `useState<SessionRow | null>(null)`
    - Line 40: `useState<any[]>([])` → `useState<SessionFlag[]>([])`
    - Line 41: `useState<any[]>([])` for rows → `useState<SessionSummaryItem[]>([])`
      (add `SessionSummaryItem` to the import)
    - Line 42: `useState<any[]>([])` for rules — inspect what `rules` actually contains
      in the component body and use `unknown[]` if the shape is genuinely unclear rather
      than `any[]`. If it is a simple object array from a rules table, define a minimal
      `RuleRow` interface inline or in session.ts.

    **Step 4 — Update `src/components/DashboardCharts.tsx`**

    - Add import: `import type { SessionRow, SessionSummaryItem } from '@/types/session'`
    - Line 8 (props interface): `sessions: any[]` → `sessions: SessionRow[]`
    - Line 146 (`findValue` parameter): `summaryItems: any[]` → `summaryItems: SessionSummaryItem[]`
    - Line 149: `(s: any)` → `(s: SessionSummaryItem)`
    - Line 169: `const summaries = (session.summary as any)?.summaries || []`
      → `const summaries: SessionSummaryItem[] = session.summary?.summaries ?? []`
    - Line 172: `const point: any = {` → `const point: Record<string, unknown> & { date: Date; formattedDate: string } = {`

    **Step 5 — Fix `src/vite-env.d.ts` (@ts-ignore removal)**

    Add the Intl type augmentation so `Intl.supportedValuesOf` is recognized:

    ```typescript
    /// <reference types="vite/client" />

    // Augment the Intl namespace to include supportedValuesOf (ES2022+).
    // TypeScript's lib.dom.d.ts does not yet include this method in older TS versions.
    declare namespace Intl {
      function supportedValuesOf(key: 'calendar' | 'collation' | 'currency' | 'numberingSystem' | 'timeZone' | 'unit'): string[];
    }
    ```

    **Step 6 — Remove @ts-ignore from `src/pages/SettingsPage.tsx`**

    With the type declaration in vite-env.d.ts, lines 32-33 become:
    ```typescript
    // Before:
    // @ts-ignore: Intl.supportedValuesOf is relatively new
    const timezones = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : [Intl.DateTimeFormat().resolvedOptions().timeZone];

    // After:
    const timezones = Intl.supportedValuesOf
      ? Intl.supportedValuesOf('timeZone')
      : [Intl.DateTimeFormat().resolvedOptions().timeZone];
    ```

    **What NOT to do:**
    - Do NOT change `rules` to `any[]` if a concrete type can be inferred — use `unknown[]`
      as the minimum improvement
    - Do NOT add types to files outside the six listed above
    - Do NOT change runtime behavior in any of these edits — this is types-only cleanup
  </action>
  <verify>
    <automated>cd C:/Users/Vanildo/Dev/car-insights-ai && npx tsc --noEmit 2>&1 | head -40</automated>
  </verify>
  <done>
    - `src/types/session.ts` exists and exports `SessionRow`, `SessionFlag`, `SessionSummaryItem`, `SessionProblem`
    - `Index.tsx`, `HistoryPage.tsx`, `DashboardCharts.tsx` import from `@/types/session` and have
      no bare `any` types in the previously flagged lines
    - `vite-env.d.ts` contains the `Intl.supportedValuesOf` declaration
    - `SettingsPage.tsx` has no `@ts-ignore` comment and no `(Intl as any)` cast
    - `npx tsc --noEmit` exits with code 0 (or only pre-existing errors unrelated to these files)
  </done>
</task>

</tasks>

<verification>
After all four tasks complete, run the following checks:

1. TypeScript clean build:
   ```
   npx tsc --noEmit
   ```
   Expected: exit code 0, or only errors from files NOT touched by this plan.

2. Dev server starts without console errors:
   ```
   npm run dev
   ```
   Open the app. Check browser console for any runtime errors on the Settings page, 
   Dashboard, History page, and Login page.

3. Auth flow manual check:
   - Hard-refresh the app (Ctrl+Shift+R)
   - Confirm the loading spinner does not flash "logged out" before "logged in"
   - Sign in with Google — confirm no console warning about VITE_APP_URL if it IS set

4. API key encryption manual check:
   - Go to Settings → enter a test Gemini API key → Save
   - Open Supabase Table Editor → app_settings table
   - Confirm `setting_value` is NOT the raw key (should be `base64:base64` format)
   - Confirm `encrypted = true`
   - Return to Settings — the key should load and display as masked (••••)

5. Migration files present:
   ```
   ls supabase/migrations/20260517_*.sql
   ```
   Expected: three files (api_key_encryption, chat_user_id_trigger, session_start_not_null).
</verification>

<success_criteria>
- Zero plaintext Gemini API keys in the `app_settings` table for any new save
- Auth `loading` state never transitions false→true between page loads
- Google OAuth throws a clear error in production if `VITE_APP_URL` is unset
- `chat_conversations` INSERT works without the client supplying `user_id`
- `session_start` column is NOT NULL in the sessions table
- `npx tsc --noEmit` exits clean across all modified files
- No `@ts-ignore` comments remain in SettingsPage.tsx
- No bare `any[]` types remain on the eight flagged lines across four files
</success_criteria>

<risks>

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Existing users have plaintext API keys in DB — the CHECK constraint (NOT VALID) will reject new saves but the old rows remain | HIGH | MEDIUM | The constraint uses `NOT VALID` so it does not reject existing rows. Users who saved before this deploy will re-encrypt on next Save in Settings. Add a one-time toast in SettingsPage on load if `encrypted = false` prompting the user to re-save. |
| `VITE_ENCRYPTION_SALT` not set in production Vercel env — encryption falls back to weak key | HIGH | HIGH | Add a startup assert in `crypto.ts` (already in Step 1). Document the required env var in README or `.env.example`. |
| Auth race fix delays route render if `onAuthStateChange` is slow to fire | LOW | LOW | Supabase fires the event synchronously from its internal token cache on first call — delay is <5ms in practice. The `getSession()` call still populates state optimistically. |
| TypeScript errors from `rules` state in HistoryPage (shape unknown) | MEDIUM | LOW | Use `unknown[]` as the fallback type for `rules` — it is strictly safer than `any[]` and compiles cleanly. |
| `Intl.supportedValuesOf` declaration conflicts with future TS lib update | LOW | LOW | The `declare namespace Intl` block extends, not replaces, the existing lib. When TS adds it natively, the redundant declaration can be removed without runtime impact. |

</risks>

<output>
After completion, create `.planning/phases/03-critical-fixes/03-01-SUMMARY.md` following
the summary template at `@$HOME/.claude/get-shit-done/templates/summary.md`.
</output>
```
