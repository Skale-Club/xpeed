# Stack Research — MCP Server for Car Insights AI

**Domain:** MCP (Model Context Protocol) server — TypeScript, Supabase-integrated
**Researched:** 2026-05-22
**Confidence:** HIGH — official SDK docs + Supabase MCP deployment guide + spec pages verified

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP server core — tools, resources, prompts, transport | **Official SDK** from Anthropic (now Linux Foundation). 15M+ weekly npm downloads, 12.4k GitHub stars, active maintenance. Zod-native API with type inference. `McpServer` class provides high-level API over JSON-RPC 2.0. |
| Hono | ^4.9.7 | HTTP framework for Streamable HTTP transport | **Edge-native.** Supabase's own MCP deployment guide uses Hono. Works in Deno (Edge Functions), Cloudflare Workers, and Node.js. TypeScript-first. Minimal overhead vs Express. |
| `zod` | ^3.25.76 (existing) | Schema validation for MCP tool parameters | **Required peer dependency** of `@modelcontextprotocol/sdk`. Already used project-wide in the frontend. SDK internally imports `zod/v4` namespace but maintains backwards compatibility with v3.25+. |
| Deno (Supabase Edge Runtime) | 2.x (managed by Supabase) | Runtime environment | **Existing infrastructure match** — the project already has Deno-based Edge Functions (`chat`, `analyze-session`). MCP server follows same pattern. Zero new infrastructure. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jose` | ^6.2.3 | JWT verification for bearer token auth | **Production JWT validation.** 0 dependencies, works in Edge/Deno, supports JWKS (JSON Web Key Sets) for verifying Supabase-issued tokens against the project's JWKS endpoint. Alternative: `supabase.auth.getUser()` if you want Supabase SDK validation instead. |
| `@supabase/supabase-js` | ^2.95.3 (via esm.sh CDN import) | Supabase data access within Edge Function | **Existing pattern.** Edge Functions import from `https://esm.sh/@supabase/supabase-js@2`. Create admin client with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars for DB queries. |
| `@modelcontextprotocol/inspector` | latest (npx) | Debugging MCP server | **Development only.** Visual inspector to test tools, resources, and prompts interactively. Run `npx @modelcontextprotocol/inspector` and point to your server URL. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `supabase functions serve` | Local MCP server testing | Use `--no-verify-jwt mcp` flag to skip auth in dev. Works with Docker. |
| `MCP Inspector` | Visual tool/resource debugging | `npx @modelcontextprotocol/inspector`. Tests tools interactively without a real MCP client. |
| `curl` | Direct MCP protocol testing | MCP speaks JSON-RPC 2.0 over HTTP. Test with explicit `Accept: application/json, text/event-stream` header. |

---

## MCP Server Architecture

### Transport Layer

**RECOMMENDED: Streamable HTTP** (via `WebStandardStreamableHTTPServerTransport`)

The MCP SDK 1.29.x supports three transports:

| Transport | Use Case | Why for This Project |
|-----------|----------|---------------------|
| **Streamable HTTP** | Remote servers | **PRIMARY.** Needed for clients like Claude Desktop, Cursor, OpenCode to connect via URL. Uses HTTP POST + SSE for streaming responses. Edge-native. |
| stdio | Local, process-spawned | Not suitable (remote MCP server). Used by local-only MCP servers. |
| Legacy SSE | Backwards compatibility | Avoid. Replaced by Streamable HTTP in spec 2025-06-18+. |

### Auth Model

**RECOMMENDED: Supabase JWT Bearer Token** (two-phase approach)

**Phase 1 (v1.1 MVP) — Bearer Token from `app_settings`:**

```
Client (Claude/Cursor/OpenCode)
  │  Authorization: Bearer <mcp_token>
  ▼
Supabase Edge Function (Deno runtime)
  │  1. Extract token from header
  │  2. Look up token in app_settings table (user-scoped)
  │  3. Resolve user identity from matching row
  │  4. All tool handlers filter queries by resolved user_id
  ▼
Supabase DB (RLS-enforced, but bypassed via service_role)
  │  All queries scoped to authenticated user_id
```

**Phase 2 (future) — Full OAuth 2.1 via Supabase Auth Server:**

Supabase has full MCP OAuth 2.1 support documented at `/docs/guides/auth/oauth-server/mcp-authentication`. This adds discovery, Dynamic Client Registration (DCR/CIMD), and PKCE flow. Not needed for v1.1 — adds consent UI and redirect handling complexity.

### Why Bearer Token over Full OAuth 2.1 for v1.1

| Criterion | Bearer Token (Phase 1) | OAuth 2.1 (Phase 2) |
|-----------|----------------------|---------------------|
| Complexity | Low — 2 columns, 1 lookup | High — consent UI, redirect handling, DCR |
| UX for user | Generate token in Settings → paste into MCP client config | OAuth popup flow (requires hosted UI) |
| Supabase infra needed | None beyond existing `app_settings` table | Must enable OAuth 2.1 Server in Supabase dashboard |
| Token rotation | Manual (user regenerates) | Automatic (refresh tokens) |
| Client support | All MCP clients support `Authorization: Bearer` | OAuth 2.1 supported by newer clients (Claude Desktop, Cursor) |
| **Verdict for v1.1** | ✅ **Start here** | ❌ Defer to v1.2+ |

---

## Installation

### MCP Server Edge Function

Create a new Edge Function for the MCP server (following the project's existing Deno pattern):

```bash
supabase functions new mcp-server
```

The Edge Function imports MCP SDK via npm specifiers (Deno Edge Runtime supports `npm:` prefix):

```typescript
// supabase/functions/mcp-server/index.ts
// NOTE: This is a DENO Edge Function — uses npm: imports, NOT npm install

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/webStandardStreamableHttp.js'
import { Hono } from 'npm:hono@^4.9.7'
import { z } from 'npm:zod@^4.1.13'
```

**IMPORTANT:** The MCP server runs on **Deno** inside Supabase Edge Functions. It does NOT use `npm install` or `package.json`. Dependencies are imported via `npm:` URLs at runtime. This matches the existing pattern in `chat/index.ts` and `analyze-session/index.ts` which import from `https://esm.sh/` and `https://deno.land/`.

### Supporting packages (frontend — Settings page token management)

These ARE regular npm dependencies for the React frontend:

```bash
npm install jose@^6.2.3
```

(Jose is used server-side in the Edge Function too, but imported via `npm:jose@^6.2.3` in Deno, not via npm install.)

### Dev dependencies (already present)

```bash
# Already in the project:
npm -D typescript supabase
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@modelcontextprotocol/sdk` v1.29.0 (stable) | v2.0.0-alpha.x | **Never for production.** v2 alpha is still under active development (April 2026). Monorepo restructure. Wait for stable release. |
| Supabase Edge Function (Deno) | Standalone Node.js server (Express/Fastify) | If the MCP server needs npm packages that don't work in Deno, or needs long-running stateful connections. **Downside:** extra infrastructure (Railway, Fly.io, or self-hosted). |
| Hono (Edge-native) | Express | If deploying as standalone Node.js server (not Edge Function). Express has wider middleware ecosystem but adds weight and doesn't run on Edge. |
| `npm:jose@^6.2.3` (JWT verification) | `supabase.auth.getUser()` | If the MCP server wants to validate Supabase tokens directly via the Supabase SDK's `getUser()` call. Simpler but adds a Supabase API call per request. Jose is **faster** (local JWT verification, no network hop). |
| `npm:zod@^4` | Zod v3 (existing) | v4 is the SDK's native namespace. But SDK maintains backwards compat with v3.25+. **Use v3 for now** (already in project). |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@modelcontextprotocol/sdk` v2 alpha | Unstable API (monorepo restructured), breaking changes, incomplete documentation. Not production-ready. | v1.29.0 (stable) |
| `npm:@fastify/fastify` or Express in Edge Functions | These frameworks expect Node.js APIs not available in Deno Edge Runtime (e.g., `net.Socket`, `http.Server`). Will crash at runtime. | Hono (Deno-compatible) |
| Custom MCP protocol implementation | Protocol is complex (JSON-RPC 2.0, capability negotiation, lifecycle). 15M+ weekly downloads on the official SDK. No benefit to reinventing. | `@modelcontextprotocol/sdk` |
| Service Role Key exposed to MCP clients | The MCP server should use the service role for DB access internally, but **never** expose it to clients. Clients only get user-scoped bearer tokens. | Bearer token stored in `app_settings`, validated server-side. |
| SSE transport (legacy) | Deprecated in spec 2025-06-18. Replaced by Streamable HTTP. Some older MCP clients may still use it, but Streamable HTTP is backward-compatible. | `StreamableHTTPServerTransport` / `WebStandardStreamableHTTPServerTransport` |

---

## MCP Specification Version

**Current stable: 2025-11-25** (verified at spec.modelcontextprotocol.io)

Key features relevant to this project:

| Feature | Included | Relevance |
|---------|----------|-----------|
| Tools (tools/call) | ✅ | Core — expose car data, session queries, DTC lookups |
| Resources (resources/read) | ✅ | Core — expose maintenance history, vehicle profiles as URIs |
| Prompts | ✅ | Nice-to-have — reusable diagnostic prompts |
| Streamable HTTP transport | ✅ | Required — remote MCP server access |
| Tasks (experimental) | ✅ | Future — long-running analysis operations |
| OAuth 2.1 (CIMD) | ✅ | Phase 2 — full auth flow via Supabase Auth |
| Elicitation | ✅ | Phase 2 — requesting user input during tool execution |
| Structured tool output | ✅ | Use now — tools return `structuredContent` for typed data |

The SDK v1.29.0 implements the 2025-11-25 spec. All MCP clients (Claude Desktop, Cursor, VS Code, OpenCode, Windsurf) support this spec version.

---

## Deployment Architecture

### Planned Structure

```
supabase/
  functions/
    mcp-server/
      index.ts              # Main Edge Function (Deno)
    _shared/
      admin-config.ts        # Existing — Gemini API key resolution
      quota.ts               # Existing — per-user quota + JWT auth helper
    chat/                    # Existing — keep as-is
    analyze-session/         # Existing — keep as-is
```

### MCP Server Function Shape

```typescript
// Pseudocode for the MCP Server Edge Function structure
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/mcp.js'
import { Hono } from 'npm:hono@^4.9.7'
// ...etc

const app = new Hono()
const server = new McpServer({
  name: 'car-insights-mcp',
  version: '1.0.0',
})

// --- Auth Middleware ---
// Validate Bearer token from app_settings before any MCP request
// Resolve user_id from the token → attach to request context

// --- Tools ---
// server.tool('list_cars', { ... }, handler)
// server.tool('get_session', { ... }, handler)
// server.tool('list_dtcs', { ... }, handler)
// server.tool('get_maintenance', { ... }, handler)
// server.tool('analyze_trends', { ... }, handler)
// server.tool('chat_with_context', { ... }, handler)

// --- Resources ---
// server.resource('car_profile', ...)
// server.resource('session_detail', ...)

// --- Transport ---
app.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

Deno.serve(app.fetch)
```

### Deployment Command

```bash
supabase functions deploy --no-verify-jwt mcp-server
```

The `--no-verify-jwt` flag is required because the MCP server handles its own auth (custom bearer token validation), not Supabase's built-in JWT verification.

### MCP Client Configuration (user-facing)

Users configure their MCP clients (Claude Desktop, Cursor, OpenCode, etc.) with:

```json
{
  "mcpServers": {
    "car-insights": {
      "type": "http",
      "url": "https://drqmrddxlrlbqnydumjm.supabase.co/functions/v1/mcp-server",
      "headers": {
        "Authorization": "Bearer <token-from-settings-page>"
      }
    }
  }
}
```

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@modelcontextprotocol/sdk` 1.29.x | Zod v3.25+ or v4.x | SDK internally imports `zod/v4` but maintains backwards compat with v3 through re-exports |
| `npm:@modelcontextprotocol/sdk` | Deno 2.x (Supabase Edge Runtime) | Works via npm specifier. All transports available including `WebStandardStreamableHTTPServerTransport` |
| `zod` v3 (existing project) | MCP SDK 1.29.x | Verified: SDK README states "maintains backwards compatibility with projects using Zod v3.25 or later" |
| `jose` 6.x | Deno, Node, Edge | 0 dependencies. All JWT algorithms supported. Use `createRemoteJWKSet` with Supabase JWKS URL |
| Supabase Edge Runtime | Deno 2.x | Managed by Supabase. No version pinning needed. |

---

## Sources

- **Context7 (modelcontextprotocol/typescript-sdk)** — SDK docs, transports, server API — HIGH confidence
- **npm registry (`@modelcontextprotocol/sdk`)** — v1.29.0 confirmed as latest stable, 15M+ weekly downloads, Zod peer dep — HIGH confidence
- **Supabase Docs: Deploy MCP servers** (`/docs/guides/getting-started/byo-mcp`) — Official guide using Hono + WebStandardStreamableHTTPServerTransport — HIGH confidence
- **Supabase Docs: MCP Authentication** (`/docs/guides/auth/oauth-server/mcp-authentication`) — Full OAuth 2.1 integration documented — HIGH confidence
- **MCP Specification** (`spec.modelcontextprotocol.io`) — 2025-11-25 confirmed as latest stable — HIGH confidence
- **WorkOS Blog: MCP 2025-11-25 Spec Update** — Reliable third-party analysis of spec changes — MEDIUM confidence
- **Supabase Blog: MCP Server announcement** (`supabase.com/blog/mcp-server`) — Confirms Supabase's investment in MCP — HIGH confidence
- **DeepWiki (typescript-sdk)** — Streamable HTTP client transport architecture — MEDIUM confidence
- **Nerd Level Tech: MCP Server OAuth 2.1** — Production deployment patterns, jose + Express setup — MEDIUM confidence

---

*Stack research for: MCP Server (Car Insights AI v1.1)*
*Researched: 2026-05-22*
