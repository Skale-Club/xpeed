# MCP Server Architecture

**Project:** Car Insights AI — MCP Server Integration
**Researched:** 2026-05-22
**Confidence:** HIGH (verified against MCP SDK docs, Supabase MCP auth docs, and community production patterns)

---

## Executive Summary

The MCP (Model Context Protocol) server for Car Insights AI should be implemented as a **separate Node.js Express application** using the `@modelcontextprotocol/sdk` (v1.x) with **Streamable HTTP transport**. This is the recommended architecture for production MCP servers as of the 2025-03-26 spec revision, which deprecated SSE transport.

**Why not reuse Edge Functions:** Supabase Edge Functions (Deno) are ill-suited for MCP because:
1. Edge Functions are stateless request-response handlers — MCP Streamable HTTP expects session state across requests
2. Supabase's gateway JWT verification (`verify_jwt`) is incompatible with Supabase's new asymmetric signing keys (post-2025)
3. The `supergateway` proxy workaround adds complexity and a runtime dependency that isn't production-viable
4. Edge Functions lack support for the bidirectional streaming MCP requires

The MCP server reuses the **existing Supabase PostgreSQL database** via the Supabase JS SDK, authenticates via **Supabase JWT Bearer token validation**, and is deployable as a **standalone Docker container** on any hosting platform.

---

## Recommended Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        EXTERNAL CLIENTS                          │
│  ┌──────────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐ │
│  │ Claude       │  │ Cursor   │  │ OpenCode│  │ Custom Agent │ │
│  │ Desktop      │  │          │  │         │  │              │ │
│  └──────┬───────┘  └────┬─────┘  └────┬────┘  └──────┬───────┘ │
│         │               │             │              │          │
└─────────┼───────────────┼─────────────┼──────────────┼──────────┘
          │               │             │              │
          │     Authorization: Bearer <supabase-jwt>   │
          │     POST /mcp  (Streamable HTTP)           │
          └───────────────┼─────────────┼──────────────┘
                          │             │
                          ▼             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MCP SERVER (Node.js + Express)                │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Auth Middleware Layer                                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │   │
│  │  │ JWT Validator │  │ User Resolver│  │ Scope Checker │  │   │
│  │  │ (jose lib)    │  │ (Supabase    │  │ (tool-level   │  │   │
│  │  │               │  │  getUser)    │  │  permission)  │  │   │
│  │  └──────────────┘  └──────────────┘  └───────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  MCP Transport Layer (StreamableHTTP)                     │   │
│  │  - POST /mcp  → JSON-RPC tool calls                      │   │
│  │  - GET  /mcp  → SSE stream for notifications             │   │
│  │  - DELETE /mcp → session teardown                        │   │
│  │  - Session management via Mcp-Session-Id header          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  MCP Server (McpServer)                                   │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐           │   │
│  │  │ Tools      │ │ Resources  │ │ Prompts    │           │   │
│  │  │ (12 tools) │ │ (read-only │ │ (templates)│           │   │
│  │  │            │ │  data)     │ │           │           │   │
│  │  └────────────┘ └────────────┘ └────────────┘           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Service / Data Access Layer                              │   │
│  │  - Supabase JS SDK (Service Role for admin ops)          │   │
│  │  - Supabase JS SDK (Anon Key + User JWT for RLS queries) │   │
│  │  - Gemini API (server-side, uses admin key)              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Observability Layer                                      │   │
│  │  - Structured logging (pino)                              │   │
│  │  - Tool usage metrics                                     │   │
│  │  - Error tracking                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXISTING INFRASTRUCTURE                       │
│                                                                 │
│  ┌────────────────────┐  ┌──────────────────────────────────┐  │
│  │ Supabase Postgres  │  │ Supabase Auth (JWT Issuer)       │  │
│  │ - car_profiles     │  │ - ES256 asymmetric signing       │  │
│  │ - sessions         │  │ - JWKS endpoint auto-discovery   │  │
│  │ - session_rows     │  │ - Token refresh & rotation       │  │
│  │ - session_flags    │  │                                  │  │
│  │ - chat_*           │  └──────────────────────────────────┘  │
│  │ - app_settings     │                                         │
│  │ - user_quotas      │  ┌──────────────────────────────────┐  │
│  │ - maintenance      │  │ Supabase Storage                 │  │
│  │   (future)         │  │ - session-csv bucket             │  │
│  └────────────────────┘  └──────────────────────────────────┘  │
│                                                                 │
│  ┌────────────────────┐  ┌──────────────────────────────────┐  │
│  │ React SPA (Vercel) │  │ Edge Functions (Deno)           │  │
│  │ - MCP Token UI     │  │ - chat (Gemini proxy)           │  │
│  │ - Settings page    │  │ - analyze-session                │  │
│  │   integration      │  │ (unchanged — still active)      │  │
│  └────────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| **Auth Middleware** | Validate Supabase JWT tokens; extract user identity; attach `authInfo` to request | Supabase Auth (JWKS endpoint); Supabase JS SDK `getUser()` |
| **MCP Transport** | Manage Streamable HTTP sessions; parse JSON-RPC; route tool/resource/prompt calls | MCP SDK's `StreamableHTTPServerTransport` |
| **MCP Server** | Register tools, resources, prompts; coordinate tool execution | Auth Middleware (receives `authInfo`); Service layer |
| **Service Layer** | All Supabase queries; domain logic reusable from existing codebase | Supabase PostgreSQL; Supabase Storage; Gemini API |
| **Observability** | Structured logging, metrics, error tracking | stdout (pino), optional external service |

---

## Data Flow

### Authentication Flow

```
MCP Client                    MCP Server                    Supabase Auth
    │                             │                             │
    │  1. POST /mcp               │                             │
    │     Authorization: Bearer   │                             │
    │     <supabase-jwt>          │                             │
    │────────────────────────────>│                             │
    │                             │  2. Decode JWT header       │
    │                             │     (extract kid, alg)      │
    │                             │                             │
    │                             │  3. Fetch JWKS              │
    │                             │     (cached, TTL 1hr)      │
    │                             │──────────────────────────> │
    │                             │  4. JWKS response           │
    │                             │<────────────────────────── │
    │                             │                             │
    │                             │  5. Verify JWT signature    │
    │                             │     (using jose library)    │
    │                             │                             │
    │                             │  6. Extract user_id from    │
    │                             │     JWT sub claim           │
    │                             │                             │
    │                             │  7. [Optional] Validate     │
    │                             │     with Supabase getUser() │
    │                             │──────────────────────────> │
    │                             │                             │
    │  8. 200 OK + MCP session    │                             │
    │<────────────────────────────│                             │
```

### Tool Invocation Data Flow

```
MCP Client                    MCP Server                         Supabase DB
    │                             │                                  │
    │  POST /mcp                  │                                  │
    │  { method: "tools/call",    │                                  │
    │    params: { name:          │                                  │
    │    "list_sessions",         │                                  │
    │    arguments: {             │                                  │
    │      car_id: "..." }}}      │                                  │
    │──────────────────────────> │                                  │
    │                             │  1. Auth middleware validates    │
    │                             │     JWT, extracts user_id       │
    │                             │                                  │
    │                             │  2. MCP SDK routes to tool      │
    │                             │     handler                     │
    │                             │                                  │
    │                             │  3. Handler calls service:      │
    │                             │     getSessions(carId)          │
    │                             │──────────────────────────────> │
    │                             │                                  │
    │                             │  4. SQL query (RLS enforced)    │
    │                             │     WHERE car_profile_id = $1   │
    │                             │     AND user_id = auth.uid()   │
    │                             │<────────────────────────────── │
    │                             │                                  │
    │                             │  5. Format result as text       │
    │                             │                                  │
    │  { content: [{ type:        │                                  │
    │    "text", text: "..." }]}  │                                  │
    │<────────────────────────── │                                  │
```

### Token Generation/Creation Flow (User-facing)

```
Browser (React SPA)                  Supabase Auth              MCP Server
    │                                     │                        │
    │  User clicks "Generate MCP Token"   │                        │
    │─────────────────────────────────────│                        │
    │                                     │                        │
    │  Option A: Use existing session     │                        │
    │  session.access_token (1hr TTL)     │                        │
    │  Store in localStorage              │                        │
    │                                     │                        │
    │  Option B: Create MCP-specific      │                        │
    │  token via custom Edge Function:    │                        │
    │  POST /functions/v1/create-mcp-token│                        │
    │  → returns long-lived token         │                        │
    │                                     │                        │
    │  Display token + connection URL     │                        │
    │  + copy-to-clipboard button         │                        │
    │─────────────────────────────────────│                        │
    │                                     │                        │
    │  User configures MCP client:        │                        │
    │  {                                  │                        │
    │    "mcpServers": {                  │                        │
    │      "car-insights": {              │                        │
    │        "type": "http",              │                        │
    │        "url": "https://mcp.         │                        │
    │          carinsights.app/mcp",      │                        │
    │        "headers": {                 │                        │
    │          "Authorization":           │                        │
    │          "Bearer <token>"           │                        │
    │        }                            │                        │
    │      }                              │                        │
    │    }                                │                        │
    │  }                                  │                        │
    │──────────────────────────────────────────────────────────>│
    │                                     │                        │
    │                                     │  Tool calls now work   │
```

---

## MCP Tools Surface

### Tier 1 — Read Tools (Table Stakes)

| Tool | Description | Data Source | Auth Scope |
|------|-------------|-------------|------------|
| `list_cars` | List user's car profiles | `car_profiles` | User-scoped RLS |
| `get_car` | Get specific car details | `car_profiles` | User-scoped RLS |
| `list_sessions` | List OBD2 sessions for a car | `sessions` | User-scoped RLS |
| `get_session` | Get session details | `sessions` | User-scoped RLS |
| `get_session_flags` | Get diagnostic flags for a session | `session_flags` | User-scoped RLS |
| `get_session_rows` | Get raw OBD2 data (paginated) | `session_rows` | User-scoped RLS |
| `get_dtc_info` | Lookup DTC code description | Hardcoded DTC map | No DB needed |

### Tier 2 — Analysis Tools (Differentiators)

| Tool | Description | Data Source | Auth Scope |
|------|-------------|-------------|------------|
| `compute_trends` | Parameter trends across sessions | `sessions` + `computeTrends()` | User-scoped RLS |
| `get_dashboard_stats` | Aggregated dashboard metrics | `get_dashboard_stats` RPC | User-scoped RLS |
| `list_maintenance` | Maintenance history | `maintenance_events` | User-scoped RLS |

### Tier 3 — AI Tools (Premium)

| Tool | Description | Data Source | Auth Scope |
|------|-------------|-------------|------------|
| `analyze_session` | Gemini analysis of a session | `sessions` + Gemini API | User-scoped RLS + admin Gemini key |
| `chat_with_context` | Chat with full vehicle context | `chat_conversations` + Gemini API | User-scoped RLS + admin Gemini key |

### Tool Registration Order (Build Phases)

```
Phase 1 (Read-only MVP):
  list_cars, get_car, list_sessions, get_session, get_session_flags, get_dtc_info

Phase 2 (Analysis):
  compute_trends, get_dashboard_stats, get_session_rows (paginated)

Phase 3 (AI Integration):
  analyze_session, chat_with_context

Phase 4 (Write — future):
  add_maintenance_event, update_flag_resolved, create_conversation
```

---

## Streamable HTTP Transport Configuration

The MCP server uses a **single POST endpoint** (`/mcp`) with Streamable HTTP transport:

```typescript
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

const app = express();
app.use(express.json());

// Session map (in-memory for single-node, or Redis for multi-node)
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  // 1. Auth check — validate Supabase JWT
  const authInfo = await validateSupabaseJwt(req.headers.authorization);
  if (!authInfo) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // 2. Session lookup or creation
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => sessions.set(sid, transport!),
      enableDnsRebindingProtection: true,
    });
    transport.onclose = () => {
      if (transport!.sessionId) sessions.delete(transport!.sessionId);
    };
  }

  // 3. Connect MCP server to transport (idempotent)
  await mcpServer.connect(transport);

  // 4. Handle request (pass authInfo for tool-level access)
  await transport.handleRequest(req, res, { authInfo });
});
```

### Stateless vs Stateful

**Start with stateful** (in-memory session map) for simplicity. The session map stores the transport instance which holds the SSE connection for server-to-client notifications.

**Scale to stateless** when multi-node deployment is needed. Remove SSE notifications, use `enableJsonResponse: true`, and validate the JWT on every request (no session affinity required).

---

## Authentication Architecture

### JWT Validation Strategy

Use the **`jose` library** to validate Supabase JWTs locally (no network call on every request):

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

// Fetch JWKS from Supabase (cached with TTL)
const JWKS = createRemoteJWKSet(
  new URL("https://<project>.supabase.co/auth/v1/.well-known/jwks.json")
);

async function validateSupabaseJwt(authHeader?: string): Promise<AuthInfo | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://<project>.supabase.co/auth/v1`,
      audience: "authenticated",
    });

    return {
      userId: payload.sub as string,
      role: payload.role as string,
      email: payload.email as string,
      // Any custom claims from Supabase Auth hooks
    };
  } catch {
    return null;
  }
}
```

### Why Not Supabase SDK `getUser()`

The existing Edge Functions use `getUser()` with a service role client. For the MCP server, **local JWT validation is preferred** because:
1. No network call on every request (JWKS fetch is cached)
2. No service role key needed in the MCP server
3. Faster tool invocation (sub-millisecond validation)
4. Works offline/air-gapped (after JWKS is cached)

### Auth Info Propagation

The MCP SDK v1.x supports `authInfo` on the transport. This flows through to tool handlers:

```typescript
// Tool handler receives authInfo via extra parameter
server.registerTool(
  "list_sessions",
  { description: "List OBD2 sessions", inputSchema: { car_id: z.string() } },
  async ({ car_id }, extra) => {
    const userId = extra.authInfo?.userId;
    // Reuse existing db.ts functions — they accept userId
    return getSessionsForUser(car_id, userId);
  }
);
```

### Multi-Tenant Isolation

Every tool handler must enforce user-scoping. Two patterns:

**Pattern A: Supabase client with user JWT (RLS)**
```typescript
const userClient = createClient(supabaseUrl, supabaseAnonKey, {
  global: { headers: { Authorization: `Bearer ${userJwt}` } },
  auth: { persistSession: false },
});
```
- RLS policies automatically filter by `auth.uid()`
- No risk of user A seeing user B's data

**Pattern B: Service role + manual user_id filter**
```typescript
const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});
// Manually add .eq('user_id', userId) to every query
```
- Simpler for complex queries
- Requires discipline to always filter by user

**Recommendation: Pattern A for user-scoped reads, Pattern B for admin operations** (quota checks, Gemini API key retrieval).

---

## Code Structure

```
car-insights-ai/
├── mcp-server/                          # NEW: Standalone MCP server package
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── .env.example
│   ├── src/
│   │   ├── index.ts                     # Entry: Express app bootstrap
│   │   ├── config.ts                    # Env vars, constants
│   │   ├── transport.ts                 # Streamable HTTP transport setup
│   │   │
│   │   ├── auth/
│   │   │   ├── middleware.ts            # Express middleware: validate JWT
│   │   │   ├── jwks.ts                  # JWKS fetch + cache
│   │   │   └── types.ts                 # AuthInfo type
│   │   │
│   │   ├── server/
│   │   │   ├── mcp-server.ts            # McpServer instance + tool registration
│   │   │   ├── register-tools.ts        # Register all tools
│   │   │   └── tools/                   # Tool implementations
│   │   │       ├── cars.ts              # list_cars, get_car
│   │   │       ├── sessions.ts          # list_sessions, get_session, get_session_flags, get_session_rows
│   │   │       ├── dtc.ts               # get_dtc_info
│   │   │       ├── trends.ts            # compute_trends
│   │   │       ├── maintenance.ts       # list_maintenance
│   │   │       ├── dashboard.ts         # get_dashboard_stats
│   │   │       └── ai.ts                # analyze_session, chat_with_context
│   │   │
│   │   ├── services/                    # Data access (adapted from src/lib/)
│   │   │   ├── supabase-client.ts       # Factory: creates anon + service clients
│   │   │   ├── sessions.ts             # Replicated from src/lib/db.ts (subset)
│   │   │   ├── cars.ts                  # Replicated from src/lib/db.ts (subset)
│   │   │   ├── maintenance.ts           # Replicated from src/lib/db-extras.ts
│   │   │   ├── trends.ts               # Re-uses domain logic from src/lib/trends.ts
│   │   │   ├── dtc.ts                   # DTC lookup map
│   │   │   └── gemini.ts               # Gemini API calls (server-side)
│   │   │
│   │   ├── middleware/
│   │   │   ├── rate-limit.ts            # Per-tool rate limiting
│   │   │   └── error-handler.ts         # Structured error responses
│   │   │
│   │   └── utils/
│   │       ├── logger.ts                # Pino logger
│   │       └── format.ts               # Response formatting helpers
│   │
│   └── tests/                           # Vitest tests
│       ├── auth.test.ts
│       ├── tools/
│       │   └── sessions.test.ts
│       └── integration/
│           └── mcp-flow.test.ts
│
├── src/                                 # Existing React SPA (unchanged)
│   └── ...
│
└── supabase/                            # Existing Supabase config (unchanged)
    └── ...
```

### Key Structural Decision: Code Reuse vs Replication

The MCP server and the React SPA have different runtimes (Node.js vs browser) and different import patterns. **Do not create a shared package** — the cost of extracting shared domain logic into a separate package is higher than the benefit. Instead:

- **Replicate** data access functions in `mcp-server/src/services/` — they are thin wrappers around Supabase queries (2-5 lines each)
- **Copy** domain logic files that are pure functions (`trends.ts`, `dtc-codes.ts`, `canonical-params.ts`) — these don't change often
- **Ignore** files that are UI-specific (`csv-parser.ts`, `insight-engine.ts`, `gemini-service.ts`) — the MCP server reimplements these in a server-native way

If duplication becomes painful (2+ changes to the same logic), extract to a shared package then. Don't optimize prematurely.

---

## Deployment Architecture

### Recommended: Docker on Cloud Run, Fly.io, or Railway

```
┌──────────────────────────────────────────────┐
│              MCP Server Container              │
│  ┌────────────────────────────────────────┐   │
│  │  Node.js 22 (Alpine)                    │   │
│  │  - Express + @modelcontextprotocol/sdk  │   │
│  │  - Port 3000                            │   │
│  │  - Health check: GET /health            │   │
│  └────────────────────────────────────────┘   │
│                                               │
│  Environment Variables:                       │
│  - SUPABASE_URL                                │
│  - SUPABASE_ANON_KEY                          │
│  - SUPABASE_SERVICE_ROLE_KEY                  │
│  - HOST (default: 0.0.0.0)                   │
│  - PORT (default: 3000)                      │
│  - LOG_LEVEL (default: info)                 │
│  - MCP_SERVER_NAME (default: car-insights)   │
│  - MCP_SERVER_VERSION (default: 1.0.0)      │
└──────────────────────────────────────────────┘
```

### Why Not Vercel Serverless

| Concern | Vercel Serverless | Standalone Container |
|---------|-------------------|---------------------|
| Session persistence | Cold starts lose in-memory state | Persistent process |
| SSE streaming | Limited (10s timeout on free) | Full support |
| WebSocket / SSE | Requires Edge Functions (limitations) | Native support |
| Cold start latency | 500ms+ for Node.js | None (always on) |
| Max execution time | 60s (Pro: 900s) | Unlimited |
| Cost at scale | Expensive ($/invocation) | Predictable ($/month) |

Vercel is ideal for the React SPA. MCP server benefits from a long-lived process.

### Health Check Endpoint

```typescript
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    version: process.env.MCP_SERVER_VERSION || "1.0.0",
    supabaseConnected: await checkSupabaseConnection(),
  });
});
```

Required by Cloud Run, Fly.io, and Railway for load balancer health checks.

---

## Integration Points with Existing System

### 1. Settings Page — MCP Connection Section

Add to `SettingsPage.tsx`:

```
┌────────────────────────────────────────────┐
│  MCP / AI Agent Integration (NEW)          │
│                                            │
│  Status: ● Connected (last used: 2m ago)   │
│                                            │
│  Your connection URL:                      │
│  https://mcp.carinsights.app/mcp          │
│                                            │
│  [Copy URL]                                │
│                                            │
│  Your access token:                        │
│  eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.   │
│  ....                                       │
│                                            │
│  [Copy Token]  [Regenerate]                │
│                                            │
│  Compatible with: Claude Desktop, Cursor,  │
│  OpenCode, and any MCP-compatible client.  │
│                                            │
│  Configuration snippet (copy to your       │
│  MCP client settings):                     │
│  {                                         │
│    "mcpServers": {                         │
│      "car-insights": {                     │
│        "type": "http",                     │
│        "url": "https://mcp.../mcp",        │
│        "headers": {                        │
│          "Authorization": "Bearer eyJ..."  │
│        }                                   │
│      }                                     │
│    }                                       │
│  }                                         │
│                                            │
│  [Copy Config Snippet]                     │
└────────────────────────────────────────────┘
```

The token shown is the user's Supabase `session.access_token`. The "Regenerate" button calls `supabase.auth.refreshSession()` to get a fresh token.

**IMPORTANT:** Supabase JWTs expire in 1 hour by default. For MCP clients that need persistent access, consider:

- **Option 1: Auto-refresh** — the MCP server returns `expires_at` in errors; client re-authenticates
- **Option 2: Longer-lived token** — create a Supabase Auth Access Token Hook that issues tokens with custom TTL for MCP
- **Option 3: API key pattern** — store a generated API key in `app_settings` (user-scoped, `user_id` set) and validate it via a `createMcpToken` Edge Function

**Recommendation:** Start with Option 1 (use existing `session.access_token`, educate users to refresh). Move to Option 2/3 in Phase 2.

### 2. Edge Function: Token Creation (Optional)

```typescript
// supabase/functions/create-mcp-token/index.ts
// Called from SettingsPage when user clicks "Generate MCP Token"
// Returns a Supabase session token scoped to the MCP audience

serve(async (req) => {
  const userId = await getUserIdFromAuth(req.headers.get("Authorization"));
  if (!userId) return new Response("Unauthorized", { status: 401 });

  // Create a session with extended TTL (e.g., 30 days)
  // Uses service role to create a token
  const { data, error } = await supabaseAdmin.auth.admin.createSession({
    user_id: userId,
    // Optional: set custom TTL via auth hook claims
  });
  
  return new Response(JSON.stringify({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    url: `${MCP_SERVER_URL}/mcp`,
  }));
});
```

### 3. Database: Usage Tracking

Add a new migration for MCP-specific usage tracking:

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_mcp_usage.sql
CREATE TABLE IF NOT EXISTS mcp_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  tool_name TEXT NOT NULL,
  invoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER,
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);

-- Index for per-user daily usage queries
CREATE INDEX idx_mcp_usage_user_date ON mcp_usage(user_id, invoked_at);
```

This is optional but recommended for:
- Rate limiting (e.g., 100 tool calls/hour/user on free tier)
- Usage analytics
- Debugging

### 4. Rate Limiting

Per-tool rate limits, matching the existing Edge Function quota pattern:

```typescript
const TOOL_RATE_LIMITS: Record<string, { requests: number; windowMs: number }> = {
  // Read tools: generous
  list_cars:        { requests: 100, windowMs: 60_000 },  // 100/min
  get_session:      { requests: 100, windowMs: 60_000 },
  get_session_rows: { requests: 30,  windowMs: 60_000 },  // Heavy query
  
  // AI tools: strict
  analyze_session:  { requests: 10,  windowMs: 3600_000 }, // 10/hr
  chat_with_context:{ requests: 30,  windowMs: 3600_000 }, // 30/hr
};
```

---

## Build Order (Dependency Graph)

```
Phase 1: Foundation
  └── mcp-server/ package scaffold (package.json, tsconfig, Dockerfile)
  └── Supabase client factory (services/supabase-client.ts)
  └── Auth middleware (auth/middleware.ts, auth/jwks.ts)
  └── Streamable HTTP transport (transport.ts)
  └── Basic MCP server (server/mcp-server.ts)
  └── Health check endpoint

Phase 2: Read Tools (MVP)
  └── services/cars.ts          (replicated from src/lib/db.ts)
  └── services/sessions.ts      (replicated from src/lib/db.ts)
  └── services/dtc.ts           (DTC lookup map)
  └── tools/cars.ts
  └── tools/sessions.ts
  └── tools/dtc.ts
  └── Integration test: tools work end-to-end

Phase 3: Analysis Tools
  └── services/trends.ts        (replicated from src/lib/trends.ts)
  └── services/maintenance.ts   (replicated from src/lib/db-extras.ts)
  └── tools/trends.ts
  └── tools/dashboard.ts
  └── tools/maintenance.ts

Phase 4: AI Tools + Settings UI
  └── services/gemini.ts        (Gemini API server-side)
  └── tools/ai.ts
  └── SettingsPage MCP section
  └── Token generation UI

Phase 5: Production Hardening
  └── Rate limiting middleware
  └── mcp_usage table + tracking
  └── Structured logging (pino)
  └── Error monitoring setup
  └── Dockerfile optimization
  └── CI/CD pipeline (GitHub Actions → deploy)
```

### Dependencies Between Phases

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
                    │                     │
                    └── Phase 4 needs     │
                        Phase 1 + 2 auth  │
                        for the UI        │
                                          │
                    Phase 5 can overlap    │
                    with any earlier phase │
```

- Phase 1 is the critical path — everything depends on it
- Phase 2 is the MVP — deliver value (read-only vehicle data to AI agents)
- Phase 3 builds on Phase 2's data access patterns
- Phase 4 can technically start in parallel with Phase 3 (different concern: UI vs data)
- Phase 5 is continuous — start basic logging in Phase 1, add rate limiting in Phase 3

---

## Anti-Patterns to Avoid

### 1. Reusing Edge Functions as MCP Server
**Why bad:** Edge Functions are stateless request handlers. MCP Streamable HTTP needs session state. The `supergateway` workaround adds a proxy layer that complicates debugging, adds latency, and ties you to Supabase's deployment model. A standalone Node.js server is simpler and more maintainable.

### 2. Using the Supabase SDK `getUser()` for Every Request
**Why bad:** `getUser()` makes a network call to Supabase Auth on every invocation. Local JWT verification (via `jose` + JWKS) is sub-millisecond and cacheable. Only use `getUser()` as a fallback when JWT verification fails.

### 3. Exposing Service Role Key in MCP Server
**Why bad:** If the MCP server is compromised, the service role key grants full database access. Instead:
- Use **anon key + user JWT** for user-scoped queries (RLS handles isolation)
- Keep service role key for admin operations only (quota checks, app_settings reads)
- Run the MCP server in a restricted network with minimal secrets

### 4. Building One Giant Tool Handler
**Why bad:** A single handler that switches on tool name becomes unmaintainable. Each tool gets its own file with its own handler function. The registration layer is a simple map:

```typescript
// Good: tools/sessions.ts exports named handlers
export const listSessionsHandler = {
  name: "list_sessions",
  schema: { car_id: z.string() },
  handler: async (args, extra) => { /* ... */ },
};
```

### 5. Skipping Auth Because "It's Just for Me"
**Why bad:** MCP clients (Claude Desktop, Cursor) can be used by anyone with access to your machine. Without auth, anyone who can reach the MCP server endpoint can read all data. Always validate the JWT.

---

## Scalability Considerations

| Concern | Single Node | Multi-Node |
|---------|-------------|------------|
| Session state | In-memory Map | Redis (shared session store) |
| Rate limiting | In-memory Map | Redis (sorted sets) |
| MCP notifications | SSE stream from handling node | Pub/sub (Redis) + any node can SSE |
| Deployment | Single container | Load balancer + N containers |
| Auth | Same (stateless JWT) | Same |
| DB connections | Single pool | Pool per node (with PgBouncer) |

**Start single-node.** If you need multi-node later:
1. Replace `Map<string, Transport>` with Redis-backed store
2. Switch to stateless mode (`enableJsonResponse: true`, no SSE)
3. Add a load balancer (Cloud Run handles this automatically)

---

## Sources

- **MCP TypeScript SDK docs** (ts.sdk.modelcontextprotocol.io) — Streamable HTTP transport, auth patterns — HIGH confidence
- **Supabase MCP Authentication docs** (supabase.com/docs/guides/auth/oauth-server/mcp-authentication) — OAuth 2.1 flow with Supabase — HIGH confidence
- **supabase-mcp-template** (github.com/matt-fournier/supabase-mcp-template) — Edge Function MCP pattern with `--no-verify-jwt` — MEDIUM confidence
- **streamable-mcp-server-template** (github.com/iceener/streamable-mcp-server-template) — Production patterns for auth, sessions, deployment — MEDIUM confidence
- **Blog: Building Production MCP Servers** (dev.to/young_gao) — Connection pooling, auth, rate limiting patterns — MEDIUM confidence
- **NPM: @modelcontextprotocol/sdk v1.29.0+** — Tool registration, resource templates, error handling — HIGH confidence
- **LogRocket: Building MCP Server with Node.js** (blog.logrocket.com, 2026-05-05) — Practical walkthrough of MCP patterns — MEDIUM confidence
- **mcp-use/supabase auth reference** (github.com/mcp-use/mcp-use) — Supabase OAuth integration for MCP — MEDIUM confidence

*Architecture analysis: 2026-05-22*
