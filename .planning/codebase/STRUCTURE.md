# Codebase Structure

**Analysis Date:** 2026-05-15

## Directory Layout

```
car-insights-ai/
├── src/                        # Source code
│   ├── main.tsx               # React entry point
│   ├── App.tsx                # Root component with routing
│   ├── index.css              # Global styles
│   │
│   ├── pages/                 # Page components (routes)
│   │   ├── Index.tsx          # Dashboard
│   │   ├── SessionDetail.tsx   # Session details view
│   │   ├── HistoryPage.tsx    # Session history list
│   │   ├── SettingsPage.tsx   # User settings
│   │   ├── CarsPage.tsx       # Car profile management
│   │   ├── LoginPage.tsx      # Login form
│   │   ├── SignupPage.tsx     # Signup form
│   │   ├── SetupAdminPage.tsx # Admin setup
│   │   └── NotFound.tsx       # 404 page
│   │
│   ├── components/            # Reusable UI components
│   │   ├── AppLayout.tsx      # Main layout wrapper
│   │   ├── PrivateRoute.tsx   # Route protection wrapper
│   │   ├── PageLoader.tsx     # Loading skeleton
│   │   │
│   │   ├── chat/              # Chat system components
│   │   │   ├── ChatContainer.tsx  # Chat modal and orchestration
│   │   │   ├── ChatInput.tsx      # Message input
│   │   │   ├── MessageList.tsx    # Message display
│   │   │   └── ChatSidebar.tsx    # Conversation list
│   │   │
│   │   ├── ChatBubble.tsx     # Floating chat button
│   │   ├── UploadCard.tsx     # CSV upload component
│   │   ├── DashboardCharts.tsx # Chart visualizations
│   │   ├── LatestTripCard.tsx # Recent trip summary
│   │   ├── GeneralInfoCard.tsx # Vehicle info
│   │   ├── SessionCharts.tsx  # Session-level charts
│   │   ├── SessionKPIs.tsx    # Key performance indicators
│   │   ├── FlagsPanel.tsx     # Diagnostic flags display
│   │   ├── AIAnalysisCard.tsx # AI analysis results
│   │   ├── NavLink.tsx        # Navigation link component
│   │   │
│   │   └── ui/                # Radix UI primitives
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── dialog.tsx
│   │       ├── form.tsx
│   │       ├── input.tsx
│   │       ├── select.tsx
│   │       ├── [20+ more UI components]
│   │
│   ├── contexts/              # React Context providers
│   │   ├── AuthContext.tsx    # Authentication state
│   │   ├── CarsContext.tsx    # Car selection state
│   │   └── SettingsContext.tsx # User preferences
│   │
│   ├── hooks/                 # Custom React hooks
│   │   ├── use-cars.ts        # Car management hook
│   │   ├── use-csv-upload.ts  # CSV upload orchestration
│   │   ├── use-toast.ts       # Toast notifications
│   │   └── use-mobile.tsx     # Mobile detection
│   │
│   ├── lib/                   # Business logic and utilities
│   │   ├── db.ts             # Core database operations
│   │   ├── csv-parser.ts     # CSV parsing logic
│   │   ├── gemini-service.ts # Gemini API integration
│   │   ├── insight-engine.ts # Diagnostic rules engine
│   │   ├── canonical-params.ts # OBD2 parameter mapping
│   │   ├── default-rules.ts  # Default diagnostic rules
│   │   ├── utils.ts          # Utility functions
│   │   │
│   │   └── chat/             # Chat system logic
│   │       ├── db.ts         # Chat database operations
│   │       └── types.ts      # Chat TypeScript types
│   │
│   ├── integrations/          # External service clients
│   │   └── supabase/         # Supabase integration
│   │       ├── client.ts     # Supabase client init
│   │       └── types.ts      # Generated DB types
│   │
│   ├── test/                  # Test utilities
│   │   └── [test setup files]
│   │
│   └── scripts/               # Utility scripts
│
├── supabase/                  # Supabase configuration
│   ├── config.toml           # Local dev config
│   └── migrations/           # Database migrations
│       ├── 20260206193301_initial.sql
│       ├── 20260209095500_gemini_integration.sql
│       ├── 20260209104400_multi_car_support.sql
│       ├── 20260219105200_session_csv_storage.sql
│       ├── 20260219161400_google_oauth.sql
│       └── 20260308_chat_system.sql
│
├── public/                    # Static assets
│
├── dist/                      # Build output (generated)
│
├── package.json              # Dependencies and scripts
├── tsconfig.json            # TypeScript config
├── tsconfig.app.json        # App-specific TS config
├── tsconfig.node.json       # Build tool TS config
├── vite.config.ts           # Vite build config
├── vercel.json              # Vercel deployment config
└── .eslintrc.js             # ESLint rules
```

## Directory Purposes

**src/:**
- Purpose: All TypeScript/React source code
- Contains: Components, pages, hooks, contexts, utilities, integrations

**src/pages/:**
- Purpose: Page-level components that correspond to routes
- Contains: Route handlers, page layouts, feature orchestration
- Key files: Index.tsx (Dashboard), HistoryPage.tsx (Session list), SessionDetail.tsx (Session view)

**src/components/:**
- Purpose: Reusable React components
- Contains: UI components (from Radix UI), feature components, layout wrappers
- Key files: AppLayout.tsx (main layout), ChatContainer.tsx (chat modal), UploadCard.tsx (CSV upload)

**src/components/chat/:**
- Purpose: Chat system UI components
- Contains: ChatContainer (orchestrator), ChatInput, MessageList, ChatSidebar
- Pattern: Modular composition of chat feature

**src/components/ui/:**
- Purpose: Unstyled Radix UI component wrappers
- Contains: 40+ styled primitives (Button, Card, Dialog, Form, Input, Select, etc.)
- Usage: Base for all custom UI components

**src/contexts/:**
- Purpose: React Context providers for global state
- Contains: AuthContext (user/session), CarsContext (car selection), SettingsContext (preferences)
- Pattern: Context + useContext custom hooks

**src/hooks/:**
- Purpose: Custom React hooks with encapsulated logic
- Contains: use-cars (car CRUD + selection), use-csv-upload (upload orchestration), use-toast (notifications)
- Pattern: Hooks that manage state and side effects

**src/lib/:**
- Purpose: Business logic, utilities, and database access
- Contains: Database operations (db.ts), CSV parsing, rule engine, API integration

**src/lib/chat/:**
- Purpose: Chat system data and logic
- Contains: db.ts (chat Supabase operations), types.ts (ChatMessage, ChatConversation interfaces)

**src/integrations/supabase/:**
- Purpose: Supabase client initialization and type definitions
- Contains: client.ts (Supabase client instance), types.ts (auto-generated database types)
- Note: types.ts is auto-generated by Supabase CLI

**supabase/migrations/:**
- Purpose: Database schema changes
- Contains: Timestamped SQL migration files
- Latest: 20260308_chat_system.sql (chat tables with RLS policies)

## Key File Locations

**Entry Points:**
- `src/main.tsx`: React DOM render, creates root element
- `src/App.tsx`: Root component, route definitions, provider setup
- `src/components/AppLayout.tsx`: Main layout wrapper with nav, sidebar, theme

**Authentication:**
- `src/contexts/AuthContext.tsx`: Auth state management
- `src/pages/LoginPage.tsx`: Login UI
- `src/pages/SignupPage.tsx`: Signup UI
- `src/components/PrivateRoute.tsx`: Route protection wrapper

**Core Features:**
- Dashboard: `src/pages/Index.tsx` + `src/components/DashboardCharts.tsx`, LatestTripCard.tsx
- Session Management: `src/pages/HistoryPage.tsx`, `src/pages/SessionDetail.tsx`
- CSV Upload: `src/components/UploadCard.tsx` + `src/hooks/use-csv-upload.ts`
- Car Management: `src/pages/CarsPage.tsx` + `src/hooks/use-cars.ts`
- Chat System: `src/components/ChatBubble.tsx` + `src/components/chat/ChatContainer.tsx`
- Settings: `src/pages/SettingsPage.tsx`

**Configuration:**
- `package.json`: Dependencies, scripts (dev, build, lint, test)
- `tsconfig.json`: TypeScript compiler options, path aliases
- `vite.config.ts`: Build configuration
- `vercel.json`: Deployment configuration

**Database:**
- `src/lib/db.ts`: Core database functions (sessions, flags, cars, settings)
- `src/lib/chat/db.ts`: Chat-specific database functions
- `src/integrations/supabase/types.ts`: Generated Supabase database types
- `supabase/migrations/`: SQL migration files

**Utilities:**
- `src/lib/csv-parser.ts`: OBD2 CSV parsing
- `src/lib/canonical-params.ts`: Parameter name mapping
- `src/lib/insight-engine.ts`: Diagnostic rule engine
- `src/lib/default-rules.ts`: Built-in diagnostic thresholds

## Naming Conventions

**Files:**
- Page components: `PascalCase.tsx` (e.g., `Index.tsx`, `HistoryPage.tsx`)
- Component files: `PascalCase.tsx` (e.g., `ChatContainer.tsx`, `UploadCard.tsx`)
- Hook files: `kebab-case.ts` (e.g., `use-cars.ts`, `use-csv-upload.ts`)
- Context files: `PascalCase.tsx` (e.g., `AuthContext.tsx`)
- Utility files: `kebab-case.ts` (e.g., `csv-parser.ts`, `canonical-params.ts`)
- UI components: `kebab-case.tsx` (e.g., `button.tsx`, `dialog.tsx`)

**Directories:**
- Feature directories: `kebab-case` (e.g., `src/components/chat/`)
- Logical groupings: `kebab-case` (e.g., `src/components/ui/`)

**Functions & Variables:**
- Functions: `camelCase` (e.g., `getSessions()`, `uploadSessionCSV()`)
- React components: `PascalCase` (e.g., `ChatContainer`, `UploadCard`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `SESSION_CSV_BUCKET`, `STORAGE_KEY`)
- Types/Interfaces: `PascalCase` (e.g., `ChatMessage`, `DashboardStats`)

## Where to Add New Code

**New Feature (multi-component):**
- Primary code: Create feature directory in `src/components/[feature-name]/`
- Page route: Add component in `src/pages/[FeatureName]Page.tsx`
- State: If shared, add context in `src/contexts/[Feature]Context.tsx`
- Logic: Add hook in `src/hooks/use-[feature].ts` if needed
- Database: Add functions to `src/lib/db.ts` or `src/lib/[feature]/db.ts`
- Tests: Create `src/[feature].test.tsx` or `src/__tests__/[feature].test.tsx`

**New Component (UI):**
- Implementation: `src/components/[ComponentName].tsx`
- If reusable primitive: `src/components/ui/[component-name].tsx`
- Tests: Co-located in `src/components/__tests__/[ComponentName].test.tsx`

**New Utilities:**
- Shared helpers: `src/lib/[utility-name].ts`
- Service integration: `src/integrations/[service]/[function].ts`

**New Database Operations:**
- Core operations: Add to `src/lib/db.ts`
- Feature-specific: Create `src/lib/[feature]/db.ts`
- Pattern: Export async functions with Supabase operations

**New Contexts:**
- File: `src/contexts/[Feature]Context.tsx`
- Pattern: createContext, Provider component, custom useContext hook
- Example: AuthContext.tsx (auth), CarsContext.tsx (cars)

**New Routes:**
- Add route definition in `src/App.tsx` Routes element
- Create page component in `src/pages/[RouteName].tsx`
- Wrap with `<AuthenticatedLayout>` if protected, `<PublicLayout>` if public

## Special Directories

**build/dist:**
- Purpose: Production bundle output
- Generated: Yes (by `npm run build`)
- Committed: No (in .gitignore)

**node_modules:**
- Purpose: Installed npm dependencies
- Generated: Yes (by `npm install`)
- Committed: No (in .gitignore)

**supabase/.temp:**
- Purpose: Local Supabase development cache
- Generated: Yes (by Supabase CLI)
- Committed: No

**.env.local:**
- Purpose: Local environment variables (Supabase URL, keys, API keys)
- Generated: No (developer creates)
- Committed: No (in .gitignore)
- Required vars: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, Gemini API key (stored in DB)

---

*Structure analysis: 2026-05-15*
