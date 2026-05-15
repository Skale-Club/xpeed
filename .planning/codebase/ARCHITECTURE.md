# Architecture

**Analysis Date:** 2026-05-15

## Pattern Overview

**Overall:** Layered Client-Side MVC with Context-Based State Management

**Key Characteristics:**
- Client-side SPA (Single Page Application) built with React and Vite
- React Context API for application-wide state (Auth, Cars, Settings)
- Supabase as backend-as-a-service for database, authentication, and storage
- Modular component architecture with reusable UI library (Radix UI)
- Feature-based routing with React Router v6
- Direct database operations through Supabase client with Row-Level Security (RLS)

## Layers

**Presentation Layer:**
- Purpose: React components for UI rendering and user interaction
- Location: `src/components/`
- Contains: Functional components using Radix UI, custom hooks, and context consumption
- Depends on: Contexts, hooks, UI components, lib utilities
- Used by: Router, page components

**Page/Route Layer:**
- Purpose: Page-level components that orchestrate feature flows
- Location: `src/pages/`
- Contains: Index.tsx (Dashboard), HistoryPage.tsx, SessionDetail.tsx, SettingsPage.tsx, CarsPage.tsx, LoginPage.tsx, SignupPage.tsx, NotFound.tsx
- Depends on: Components, contexts, hooks, database functions
- Used by: React Router (App.tsx)

**Context/State Management Layer:**
- Purpose: Global state and business logic via React Context API
- Location: `src/contexts/`
- Contains: AuthContext.tsx, CarsContext.tsx, SettingsContext.tsx
- Depends on: Supabase client, hooks, database functions
- Used by: All pages and components that need shared state

**Hooks Layer:**
- Purpose: Custom React hooks encapsulating reusable logic
- Location: `src/hooks/`
- Contains: use-cars.ts, use-csv-upload.ts, use-toast.ts, use-mobile.tsx
- Depends on: Database functions, Supabase client, contexts
- Used by: Contexts, components, pages

**Data/Database Layer:**
- Purpose: All database operations and external API calls
- Location: `src/lib/` (db.ts, chat/db.ts, gemini-service.ts)
- Contains: Supabase queries, file storage operations, Gemini API integration, CSV parsing
- Depends on: Supabase client, external APIs (Google Generative AI)
- Used by: Hooks, contexts, components

**Integration Layer:**
- Purpose: External service clients and configuration
- Location: `src/integrations/`
- Contains: Supabase client initialization, auto-generated Supabase types
- Depends on: Environment variables
- Used by: Database layer, contexts

**Utility Layer:**
- Purpose: Shared utilities and helper functions
- Location: `src/lib/` (utils.ts, csv-parser.ts, insight-engine.ts, canonical-params.ts)
- Contains: CSV parsing logic, insight rule engine, parameter mapping
- Used by: Database layer, components, hooks

**UI Component Library:**
- Purpose: Reusable unstyled Radix UI components with Tailwind styling
- Location: `src/components/ui/`
- Contains: Button, Card, Dialog, Form, Input, Select, etc.
- Used by: All components

## Data Flow

**User Registration/Login Flow:**

1. User navigates to `/login` or `/signup` → PublicLayout renders LoginPage
2. LoginPage.tsx calls `signIn()` or `signUp()` from AuthContext
3. AuthContext.tsx uses Supabase auth methods (`signInWithPassword`, `signUp`, `signInWithOAuth`)
4. Supabase auth state changes trigger `onAuthStateChange` listener
5. AuthContext updates `user` and `session` state
6. Navigation guards in PrivateRoute enforce authentication
7. Authenticated routes render AuthenticatedLayout wrapping the page content

**Session Upload & Processing Flow:**

1. User selects CSV file on Dashboard or HistoryPage
2. UploadCard.tsx invokes `useCSVUpload` hook
3. `useCSVUpload` (use-csv-upload.ts) parses CSV and extracts OBD2 data
4. Data is validated against canonical parameters (canonical-params.ts)
5. CSV file is uploaded to Supabase storage: `session-csv` bucket
6. Session record created in `sessions` table via `createSession()` (db.ts)
7. Session rows bulk-inserted into `session_rows` table (200-row batches)
8. Default rules from `DEFAULT_PRIUS_RULES` applied, flags generated and inserted
9. On success, UploadCard calls `onComplete(sessionId)` to refresh UI

**Dashboard/Session Viewing Flow:**

1. Index.tsx (Dashboard) loads on protected route
2. Uses `useCarsContext()` to get selected car and cars list
3. CarsContext derives from `useCars()` hook which manages localStorage-persisted selection
4. On load, fetches sessions via `getSessions(selectedCarId)` (db.ts)
5. Calculates dashboard stats (health score, trends) from session data
6. Renders UploadCard for CSV input, DashboardCharts, LatestTripCard
7. Clicking session navigates to `/session/:id` → SessionDetail.tsx
8. SessionDetail.tsx loads session data, flags, and rows from database
9. Displays flags, charts, and diagnostic information

**Chat System Flow:**

1. ChatBubble component (fixed button) opens ChatContainer modal
2. ChatContainer.tsx loads conversations from `chat_conversations` table (RLS-protected)
3. Builds ChatContext by fetching selected car profile and recent sessions
4. User sends message → Gemini API receives message with system prompt + context
5. Gemini response saved to `chat_messages` table via `saveMessage()`
6. Messages load with `getMessages()`, displayed in MessageList.tsx
7. Conversation title auto-generated from first message
8. All chat data persisted to Supabase with user_id for data isolation

**Settings & Preferences Flow:**

1. SettingsPage.tsx displays user preferences and API key configuration
2. Distance unit and timezone stored in localStorage (SettingsContext)
3. Gemini API key stored in `app_settings` table (encrypted flag noted)
4. Settings loaded from database on app initialization
5. Changes trigger updates to local state and database persistence

## State Management

**Global State (React Context):**
- **AuthContext:** user, session, loading, auth methods (signIn, signUp, signOut, resetPassword)
- **CarsContext:** cars array, selectedCar, selectedCarId, loading, CRUD methods, localStorage persistence
- **SettingsContext:** distanceUnit, timezone, localStorage persistence

**Local Component State:**
- Page-level state: sessions list, filters, expanded details
- Form state: upload progress, input values, editing modes
- UI state: sidebar open/close, modals, loading indicators

**Server State (via Supabase):**
- Sessions, session rows, flags, car profiles, chat conversations, chat messages, app settings

## Key Abstractions

**useCars Hook:**
- Purpose: Centralized car management with auto-selection logic
- Location: `src/hooks/use-cars.ts`
- Pattern: Custom hook managing local state + Supabase persistence
- Provides: cars array, selectedCar, selectCar(), createCar(), updateCar(), deleteCar(), refresh()

**useCSVUpload Hook:**
- Purpose: File upload and CSV parsing with progress tracking
- Location: `src/hooks/use-csv-upload.ts`
- Pattern: Encapsulates multi-step upload process with progress callbacks
- Handles: File parsing, Supabase storage upload, session creation, row/flag insertion

**Chat System:**
- Purpose: AI-powered conversation interface with vehicle data context
- Files: ChatContainer.tsx, ChatInput.tsx, MessageList.tsx, ChatSidebar.tsx, chat/db.ts, chat/types.ts
- Pattern: Message-based with Vercel AI SDK-compatible format
- Integrates: Gemini 2.5 Flash API, vehicle context data

**Database Abstraction (db.ts files):**
- Purpose: Centralized database access layer
- Files: `src/lib/db.ts` (core), `src/lib/chat/db.ts` (chat)
- Pattern: Function-per-operation, consistent error handling, RLS enforcement
- Data: Sessions, car profiles, flags, settings, chat conversations/messages

## Entry Points

**Application Bootstrap:**
- Location: `src/main.tsx`
- Triggers: Browser page load
- Responsibilities: Render React app into DOM, initialize root

**Application Root:**
- Location: `src/App.tsx`
- Triggers: main.tsx renders App
- Responsibilities: Set up providers (QueryClient, TooltipProvider, AuthProvider, SettingsProvider), define routes, render layout wrappers

**Authentication:**
- Location: `src/contexts/AuthContext.tsx`
- Triggers: App initialization
- Responsibilities: Initialize auth state, listen for auth changes, provide auth methods

**Cars Context:**
- Location: `src/contexts/CarsContext.tsx`
- Triggers: AuthenticatedLayout wraps protected routes
- Responsibilities: Load cars, manage selection, provide CRUD operations

**Router:**
- Location: `src/App.tsx` Routes definition
- Routes:
  - Public: `/login`, `/signup`, `/setup-admin`
  - Protected: `/` (Index/Dashboard), `/session/:id`, `/history`, `/cars`, `/settings`
  - Fallback: `*` (NotFound)

## Error Handling

**Strategy:** Try-catch with toast notifications and console logging

**Patterns:**
- Database operations throw errors, caught by components/hooks
- Supabase auth errors logged to console with toast notification
- File upload errors caught and displayed via toast
- Chat API errors result in message removal and error toast
- Missing API key blocks chat functionality with inline messaging

## Cross-Cutting Concerns

**Authentication:** 
- Supabase JWT in localStorage, auto-refreshed via `autoRefreshToken: true`
- PrivateRoute component enforces route protection
- AuthProvider listener syncs user state across tabs

**Data Isolation (RLS):**
- Chat conversations/messages: `auth.uid() = user_id` policy
- Car profiles: User can only access own profiles
- Sessions: Cascade delete with car profile

**Logging:**
- console.error/warn for async operations
- No structured logging framework; relies on browser console

**Validation:**
- CSV parsing validates date formats and numeric values
- Forms use react-hook-form with Zod schemas (in form components)
- Supabase type system provides TypeScript validation

**CSV Processing:**
- Custom parser (csv-parser.ts) handles OBD2 data extraction
- Canonical parameter mapping (canonical-params.ts) normalizes field names
- Insight engine (insight-engine.ts) applies threshold-based rules

---

*Architecture analysis: 2026-05-15*
