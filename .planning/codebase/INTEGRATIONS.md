# External Integrations

**Analysis Date:** 2026-05-15

## APIs & External Services

**Google Gemini AI:**
- Google Generative AI - AI analysis of vehicle OBD2 diagnostic data
  - SDK/Client: @google/generative-ai 0.24.1
  - Service: Used for vehicle analysis and chat conversations
  - Usage location: `src/lib/gemini-service.ts`
  - Auth: `gemini_api_key` stored in app_settings table (Supabase)
  - Model default: `gemini-2.5-flash` (configurable, stored in `app_settings`)
  - Functions:
    - `analyzeSession()` - Analyzes OBD2 session data
    - `chatWithVehicleData()` - Chat interface with vehicle context
    - `validateApiKey()` - Validates API key functionality

**Vercel Analytics:**
- Vercel Web Analytics - Performance and usage monitoring
  - SDK/Client: @vercel/analytics 1.6.1
  - Imported in `src/App.tsx`
  - No configuration needed (automatic tracking)

## Data Storage

**Databases:**
- Supabase PostgreSQL
  - Connection: `VITE_SUPABASE_URL` (via @supabase/supabase-js)
  - Client: Supabase JS SDK (`src/integrations/supabase/client.ts`)
  - Project ID: `drqmrddxlrlbqnydumjm`
  - Auth Type: Supabase Auth (JWT tokens, localStorage persistence)

**File Storage:**
- Supabase Storage - CSV file uploads
  - Bucket: `session-csv`
  - Location: `src/lib/db.ts` handles uploads and downloads
  - Functions:
    - `uploadSessionCSV()` - Stores OBD2 data files
    - `downloadSessionCSV()` - Retrieves stored sessions
    - File path pattern: `{userId}/{carProfileId}/{timestamp}-{uuid}-{filename}`

**Caching:**
- TanStack React Query (@tanstack/react-query) - Client-side data caching
  - Manages server state synchronization
  - No explicit remote cache configured

## Authentication & Identity

**Auth Provider:**
- Supabase Auth
  - Implementation: Email/Password + Google OAuth
  - Location: `src/contexts/AuthContext.tsx`
  - Methods:
    - `signInWithPassword()` - Email/password authentication
    - `signInWithOAuth()` - Google OAuth flow (provider: 'google')
    - `signUp()` - New account creation
    - `resetPasswordForEmail()` - Password reset flow
  - Session persistence: localStorage
  - Auto token refresh: enabled
  - OAuth redirect: `VITE_APP_URL` environment variable

**Database Tables Related to Auth:**
- `users` - Supabase built-in auth users
- `app_settings` - User-specific settings (contains API keys)
- RLS (Row Level Security) policies enforced on all tables

## Monitoring & Observability

**Error Tracking:**
- None explicitly configured
- Console logging used (`console.error()` throughout codebase)

**Logs:**
- Browser console (development)
- Supabase server logs (production)
- Vercel logs (platform-level)

**Analytics:**
- Vercel Analytics (`@vercel/analytics/react` in `src/App.tsx`)

## CI/CD & Deployment

**Hosting:**
- Vercel (inferred from `vercel.json` and `@vercel/analytics` integration)
- Deployment: SPA with client-side routing

**CI Pipeline:**
- None explicitly configured (likely Vercel git integration)

**Build Artifacts:**
- Output directory: `dist/` (Vite default)
- Build command: `vite build`
- Development server: `vite` (port 5000)

## Environment Configuration

**Required env vars for development:**

| Variable | Purpose | Type |
|----------|---------|------|
| `VITE_SUPABASE_PROJECT_ID` | Supabase project identifier | string |
| `VITE_SUPABASE_URL` | Supabase API endpoint | string (https://project.supabase.co) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public Supabase API key | string |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase admin key | string (secret) |
| `VITE_APP_URL` | Application URL (OAuth redirect) | string (https://app-domain.vercel.app) |
| `VITE_ADMIN_EMAIL` | Admin account email (client-side) | string |
| `VITE_ADMIN_PASSWORD` | Admin password (client-side) | string |
| `ADMIN_EMAIL` | Admin email (Node.js scripts) | string |
| `ADMIN_PASSWORD` | Admin password (Node.js scripts) | string |

**Secrets location:**
- `.env` file (local development - not committed)
- Environment variables on Vercel deployment platform
- API keys stored in Supabase `app_settings` table (user-specific, encrypted recommended but currently not)

## Webhooks & Callbacks

**Incoming:**
- None explicitly configured

**Outgoing:**
- OAuth callback from Supabase/Google Auth to `VITE_APP_URL/`
- Password reset callback to `{window.location.origin}/reset-password`

## Database Schema

**Key Tables:**

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `car_profiles` | Vehicle information | id, name, notes, user_id, created_at, is_admin |
| `sessions` | OBD2 data upload sessions | id, car_profile_id, source_filename, uploaded_at, duration_seconds, gemini_analysis, created_at |
| `session_rows` | Individual data points | id, session_id, t_seconds, t_timestamp, data (JSON) |
| `session_flags` | Diagnostic alerts | id, session_id, severity, canonical_key, parameter_key, message, evidence (JSON), resolved |
| `chat_conversations` | Chat sessions | id, user_id, car_profile_id, title, created_at, updated_at |
| `chat_messages` | Individual chat messages | id, conversation_id, role, parts (JSON), attachments (JSON), created_at |
| `app_settings` | User preferences | setting_key, setting_value, user_id, encrypted |

## Data Flow Integration

**Session Analysis Flow:**
1. User uploads CSV file via `src/lib/db.ts:uploadSessionCSV()`
2. File stored in Supabase Storage bucket (`session-csv`)
3. Session record created in `sessions` table
4. CSV parsed and data inserted into `session_rows` table (batched in chunks of 200)
5. Flags calculated and inserted into `session_flags` table
6. Gemini API analyzes aggregated data: `src/lib/gemini-service.ts:analyzeSession()`
7. Analysis result stored in `sessions.gemini_analysis` field
8. Results displayed in `src/pages/SessionDetail.tsx`

**Chat Flow:**
1. User initiates conversation in `src/components/chat/ChatContainer.tsx`
2. Conversation created in `chat_conversations` table
3. User message saved to `chat_messages` table
4. Context built from vehicle data: `src/lib/chat/db.ts:buildChatContext()`
5. Message sent to Gemini API via `src/lib/gemini-service.ts:chatWithVehicleData()`
6. AI response saved to `chat_messages` table
7. Messages displayed in chat UI

---

*Integration audit: 2026-05-15*
