# Feature Research: Car Insights AI — MCP Server

**Domain:** MCP (Model Context Protocol) server for car diagnostics data
**Researched:** 2026-05-22
**Confidence:** HIGH

## Executive Summary

This MCP server exposes the Car Insights AI ecosystem to LLMs via Anthropic's Model Context Protocol. The server acts as a domain-specific bridge — LLMs can query car profiles, OBD2 sessions, diagnostic trouble codes, maintenance history, and compute trends using standard MCP primitives (tools, resources, prompts). Auth is handled via Supabase JWT (OAuth 2.1 with PKCE), reusing the existing user base and RLS policies.

The server follows the **Aggregator pattern** (from MCP architecture best practices): it combines multiple data sources (Supabase DB, Gemini AI, DTC lookup) behind a single MCP server, exposing them as cohesive, high-level tools rather than 1:1 mappings of database tables.

**Key design decisions:**
- **Tools for actions** (compute, analyze, mutate), **Resources for read-only data** (profiles, sessions, DTCs), **Prompts for guided workflows**
- `camelCase` tool naming (MCP community standard)
- Read-only by default — mutations require explicit opt-in and user confirmation
- Auth-gated via Supabase JWT; no tool exposes the admin Gemini API key

## Feature Landscape

### Table Stakes — MCP Server Basics

Every MCP server must provide these for an LLM to use it effectively. Missing these = server feels useless.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **`list_cars` tool** | LLM needs to discover which vehicles the user owns before querying anything else | LOW | Single-table SELECT on `car_profiles`, filtered by `user_id` via RLS |
| **`get_car` tool** | LLM needs full details of a specific car (make, model, year, VIN, engine type) for contextual analysis | LOW | Single-row lookup by `id` |
| **`list_sessions` tool** | Core navigation — LLM needs to find OBD2 sessions by car profile, with date/summary preview | MEDIUM | Query `sessions` table with optional car_profile_id filter, returns summary + uploaded_at + duration |
| **`get_session` tool** | LLM needs raw session data (columns, summary, gemini_analysis, active DTCs) for deeper analysis | LOW | Single-row lookup by `id`, returns full session object |
| **`get_session_flags` tool** | LLM needs diagnostic flags/alerts from a session to explain problems | LOW | Query `session_flags` by `session_id`, ordered by severity |
| **`get_dtc_info` tool** | DTC lookup is the most basic diagnostic expectation — LLM must explain what a trouble code means | LOW | Pure local lookup from `dtc-codes.ts` curated map (120+ codes), no DB call |
| **Auth via Supabase JWT** | Every MCP request must be authenticated as a specific user; anonymous access is not acceptable | MEDIUM | Validate Bearer JWT on every request; extract `user_id` from token claims; RLS applies automatically |
| **Error handling** | Tools must return meaningful errors (not found, forbidden, server error) using MCP's `isError: true` pattern | LOW | Standard tool return pattern: `{ content: [...], isError: true }` |

### Table Stakes — Diagnostics-Specific

Features a car diagnostics MCP server must have to be considered functional.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **`get_session_summary` tool** | LLM needs parameter summaries (min, max, avg, median per OBD2 parameter) from a session | MEDIUM | Reads `summary` JSONB column from `sessions` table; structured extraction |
| **`list_maintenance` tool** | Basic vehicle history — LLM needs to correlate flags with recent maintenance | LOW | Query `maintenance_events` by `car_profile_id`, ordered by date |
| **`compute_trends` tool** | "Is this getting worse?" — LLM needs to compare recent vs historic parameter averages | MEDIUM | Reuses `computeTrends()` from `trends.ts`; compares recent N sessions vs prior M sessions |
| **`search_sessions` tool** | LLM needs to find sessions by date range, DTC codes, or parameter anomalies | HIGH | Requires filtering across sessions + session_flags + session_rows; pagination needed for large datasets |
| **`get_dashboard_stats` tool** | LLM needs the same aggregated view the UI dashboard shows (health score, active DTCs, trend data) | MEDIUM | Calls the existing `get_dashboard_stats` RPC; returns health score, totals, status |
| **Tool annotations** | MCP clients use `readOnlyHint`, `destructiveHint` to gate tool calls appropriately | LOW | Annotations on each tool: query tools get `readOnlyHint: true`; mutation tools get `destructiveHint: true` |

### Differentiators — What Makes This MCP Server Special

Features that set this server apart from a generic "database MCP server" pointed at Supabase.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **`analyze_session` tool** | LLM can trigger Gemini AI analysis of a session directly — returns structured findings, not raw data | HIGH | Calls existing `analyze-session` Edge Function; requires admin-configured Gemini API key; returns `{summary, key_findings, recommended_action}` |
| **`chat_with_context` tool** | LLM can start a contextual chat about a vehicle with full enriched context (trends, DTCs, maintenance) | HIGH | Reuses `buildChatContext()` from `chat/db.ts`; assembles vehicle + trends + DTCs + maintenance into a rich context blob for the AI |
| **`compare_sessions` tool** | LLM can compare two or more sessions side-by-side — identify what changed, what improved, what worsened | HIGH | Cross-session parameter diff; highlights deltas between any two sessions; no existing frontend equivalent |
| **Resource URIs** | Structured, navigable data via MCP resources (not just tools) enables caching and subscription patterns | MEDIUM | Resources like `car://profiles/{id}`, `dtc://{code}`, `car://{id}/sessions/{sid}/flags` give LLMs predictable data URLs |
| **Prompts for guided workflows** | Reusable prompt templates for common diagnostic workflows (`/diagnose-session`, `/trend-report`, `/car-health`) | MEDIUM | Prompts guide the LLM through structured analysis; e.g., `/diagnose-session` walks through flags → DTCs → trends → recommendations |
| **`get_car_health_summary` tool** | One-shot comprehensive vehicle health: combine dashboard stats + active flags + recent DTCs + trends + maintenance due | HIGH | Aggregation tool that combines 5+ data sources into a single structured response — saves the LLM multiple round trips |
| **`create_maintenance_event` tool** | LLM can log maintenance directly (e.g., "record that I changed the oil today") | LOW | Simple INSERT into `maintenance_events`; annotated with `destructiveHint: true` |
| **`toggle_flag_resolved` tool** | LLM can mark flags as resolved after maintenance | LOW | UPDATE `session_flags` by `id`; annotated with `destructiveHint: true` |
| **`get_session_rows_preview` tool** | LLM can inspect raw time-series OBD2 data for a specific parameter/time range | HIGH | Reads from `session_rows` table; needs pagination/limiting (100 rows max); parameter filtering |

### Anti-Features — Things to NOT Expose as Tools

Features that seem useful but create problems in practice.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **`delete_session` tool** | "Let the LLM clean up sessions" | Too destructive; accidental deletion via prompt injection is catastrophic | Expose as read-only; deletion stays in the UI |
| **`create_car_profile` tool** | "Let the LLM add cars" | Would create confusion with existing profile creation flow; VIN decoding complexity | Use `/add-car` prompt that guides the user through UI |
| **`upload_csv` tool** | "Let the LLM upload OBD2 data via chat" | File handling through MCP is awkward; security risk with arbitrary file uploads | Keep CSV upload in the web UI; LLM can reference uploaded sessions |
| **Raw SQL / `query_database` tool** | "Give the LLM direct database access" | Extreme prompt injection risk — the entire RLS debate of 2025 proved this is dangerous | Expose specific, bounded tools that operate through the domain model, not raw tables |
| **`list_admin_settings` tool** | "Let the LLM check AI config" | Exposes Gemini API key presence; leaks admin surface area | No tool should expose admin configuration |
| **`update_session` tool** | "Let the LLM correct session data" | Session data should be immutable once created (audit trail) | Users can re-upload corrected CSVs through the UI |
| **`get_session_photos` tool** | "Show photos via MCP" | MCP doesn't handle binary/image data well; photo URLs expire | Return photo URLs as text; LLM can reference them |
| **`get_shared_report` tool** | "Access shared reports" | Shared reports use anonymous access (bypasses RLS); LLM should not be an anonymous consumer | Only expose the user's own data via authenticated tools |

## Feature Dependencies

```
Authentication (JWT validation)
    └──requires──> User identity extraction
                        └──requires──> RLS policy context

list_cars
    └──requires──> Auth + user_id

list_sessions
    └──requires──> Auth + car_profile_id (from list_cars)

get_session
    └──requires──> Auth + session_id (from list_sessions)

get_session_flags
get_session_summary
get_session_rows_preview
    └──requires──> Auth + session_id (from get_session)

get_dtc_info
    └──requires──> Auth (standalone, no DB dependency)

list_maintenance
    └──requires──> Auth + car_profile_id (from list_cars)

create_maintenance_event
    └──requires──> Auth + car_profile_id
    └──enhances──> list_maintenance (new events appear)

compute_trends
    └──requires──> Auth + car_profile_id
    └──requires──> list_sessions (needs session list)

get_dashboard_stats
    └──requires──> Auth + car_profile_id
    └──requires──> [optional] date_from parameter

get_car_health_summary (aggregator)
    └──requires──> get_dashboard_stats
    └──requires──> list_maintenance
    └──requires──> compute_trends
    └──requires──> get_session_flags (from latest session)

analyze_session
    └──requires──> get_session (session data)
    └──requires──> Admin-configured Gemini API key (app_settings)
    └──requires──> Edge Function 'analyze-session' (deployed)

chat_with_context
    └──requires──> get_car (vehicle profile)
    └──requires──> chat/db.ts:buildChatContext (trends, DTCs, maintenance)
    └──requires──> Admin-configured Gemini API key
    └──requires──> Edge Function 'chat' (deployed)

Resource URIs
    └──enhances──> All query tools (clients can read data without calling tools)
```

### Dependency Notes

- **Auth is the root dependency** — no tool works without JWT validation. This is the first thing to implement in the MCP server middleware.
- **`get_car_health_summary` is an aggregator** — it combines data from 5+ sources. Its implementation cost is high but it saves the LLM 4-5 sequential tool calls, dramatically reducing token usage.
- **`analyze_session` and `chat_with_context`** depend on deployed Edge Functions AND an admin-configured Gemini API key. If the key isn't set, these tools should return a clear error ("AI analysis unavailable — admin must configure Gemini API key").
- **`compare_sessions`** is the most complex cross-session feature — it needs parameter-level diffing logic not currently in the codebase.

## MVP Definition

### Phase 1 — Core Read-Only (Launch)

The minimum viable MCP server. LLMs can query all data but cannot mutate anything.

- [x] **Auth middleware** — JWT validation + user identity extraction
- [ ] **`list_cars`** tool — discover vehicles
- [ ] **`get_car`** tool — vehicle details
- [ ] **`list_sessions`** tool — browse OBD2 sessions
- [ ] **`get_session`** tool — session details
- [ ] **`get_session_flags`** tool — diagnostic flags
- [ ] **`get_dtc_info`** tool — DTC code lookup
- [ ] **`list_maintenance`** tool — maintenance history
- [ ] **Error handling** — proper MCP-formatted errors for all tools
- [ ] **Tool annotations** — `readOnlyHint: true` on all tools

**Why this is MVP:** Even without AI analysis or mutations, an LLM can answer "what's wrong with my car?" by reading flags, looking up DTCs, and checking maintenance history. This is the core diagnostic loop.

### Phase 2 — Analysis & Trends (Differentiation)

Adds intelligence — trends, aggregation, and Gemini integration.

- [ ] **`compute_trends`** tool — "Is X getting worse?"
- [ ] **`get_dashboard_stats`** tool — aggregated health overview
- [ ] **`get_car_health_summary`** tool — one-shot comprehensive health
- [ ] **`search_sessions`** tool — find sessions by criteria
- [ ] **`get_session_rows_preview`** tool — raw data inspection
- [ ] **`analyze_session`** tool — trigger Gemini AI analysis
- [ ] **`chat_with_context`** tool — contextual AI chat
- [ ] **Prompts** — `/diagnose-session`, `/car-health` prompt templates

**Why Phase 2:** These features require the Phase 1 tools to be working. Trends need sessions, analysis needs sessions, chat needs vehicle context. The aggregator tools reduce round-trips once the basic data layer is solid.

### Phase 3 — Guided Workflows & Mutations (Power User)

Adds action capabilities and structured workflows.

- [ ] **`create_maintenance_event`** tool — log maintenance
- [ ] **`toggle_flag_resolved`** tool — acknowledge flags
- [ ] **`compare_sessions`** tool — session diffing
- [ ] **All prompts** — `/compare-sessions`, `/maintenance-review`, `/trend-report`
- [ ] **Resources** — full resource URI scheme (`car://`, `dtc://`)
- [ ] **Rate limiting** — per-user/session tool call quotas
- [ ] **Audit logging** — log every tool call with timestamp, user, params

**Why Phase 3:** Mutations must come after the read-only layer is stable. Prompts depend on tools being available. Resource URIs are a nice-to-have overlay on the tool layer.

## Tool Input/Output Specifications

### Core Query Tools

| Tool | Input Schema | Output Content | Notes |
|------|-------------|----------------|-------|
| `list_cars` | `{}` | `CarProfile[]` as JSON string | Returns user's cars via RLS; no params needed |
| `get_car` | `{ carProfileId: string }` | `CarProfile` as JSON string | 404 if not found or not owned by user |
| `list_sessions` | `{ carProfileId: string }` | `Session[]` (list summary) as JSON string | Ordered by `uploaded_at` DESC |
| `get_session` | `{ sessionId: string }` | Full `Session` as JSON string | Includes `summary`, `gemini_analysis`, `active_dtcs` |
| `get_session_flags` | `{ sessionId: string }` | `SessionFlag[]` as JSON string | Ordered by severity; includes `canonical_key`, `message`, `evidence` |
| `get_session_summary` | `{ sessionId: string }` | `ParameterSummary[]` as JSON string | Extracted from `session.summary.summaries` |
| `get_dtc_info` | `{ codes: string[] }` | `DtcInfo[]` as JSON string | Lookup from curated 120+ code map; returns generic info for unknown codes |
| `list_maintenance` | `{ carProfileId: string }` | `MaintenanceEvent[]` as JSON string | Ordered by `performed_at` DESC |
| `search_sessions` | `{ carProfileId, dateFrom?, dateTo?, dtcCodes?, parameterKey? }` | `Session[]` as JSON string | Paginated; filtering by DTCs requires JOIN with `session_flags` |
| `get_session_rows_preview` | `{ sessionId, parameterKey?, limit? }` | `SessionRow[]` as JSON string | Max 100 rows; optional parameter filter |

### Analysis Tools

| Tool | Input Schema | Output Content | Notes |
|------|-------------|----------------|-------|
| `compute_trends` | `{ carProfileId, recentCount?: number (default 5), historicCount?: number (default 20) }` | `ParameterTrend[]` as JSON string | Reuses `computeTrends()`; fields: `canonical_key`, `current_avg`, `historic_avg`, `delta_pct`, `trend` |
| `get_dashboard_stats` | `{ carProfileId, dateFrom?: string }` | `DashboardStatsResult` as JSON string | Calls `get_dashboard_stats` RPC |
| `get_car_health_summary` | `{ carProfileId }` | Aggregated health report as JSON string | Combines dashboard_stats + latest flags + active DTCs + top trends + recent maintenance + maintenance due |
| `compare_sessions` | `{ sessionIds: string[] }` | Session diff report as JSON string | Parameter-by-parameter comparison; highlights deltas, common flags, unique flags |

### Mutation Tools

| Tool | Input Schema | Output Content | Annotations |
|------|-------------|----------------|-------------|
| `create_maintenance_event` | `{ carProfileId, eventType, performedAt, odometerKm?, cost?, currency?, shop?, notes? }` | Created `MaintenanceEvent` as JSON string | `destructiveHint: true`, `idempotentHint: false` |
| `toggle_flag_resolved` | `{ flagId: string, resolved: boolean }` | Success message | `destructiveHint: true`, `idempotentHint: true` |

### AI-Integrated Tools

| Tool | Input Schema | Output Content | Notes |
|------|-------------|----------------|-------|
| `analyze_session` | `{ sessionId, model?: string }` | `AnalysisResult` (`{summary, key_findings, recommended_action}`) | Calls Edge Function; fails gracefully if no API key configured |
| `chat_with_context` | `{ carProfileId, message, conversationId? }` | AI reply text | Maintains conversation continuity; builds full vehicle context |

## Auth Considerations

### Authentication Flow

```
MCP Client                    MCP Server                    Supabase Auth
    │                              │                              │
    │── tools/list ──────────────► │                              │
    │   Authorization: Bearer JWT  │                              │
    │                              │── validate JWT ────────────►│
    │                              │◄── user_id, role ───────────│
    │                              │                              │
    │                              │── query via supabase ──────►│
    │                              │   (RLS applies via user_id)  │
    │◄── tools list ──────────────│                              │
    │                              │                              │
```

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| **Use Supabase JWT** | Reuses existing auth infrastructure; RLS applies automatically; supported by Supabase OAuth 2.1 docs for MCP |
| **Validate JWT in server code** | Supabase Edge Functions gateway JWT verification is incompatible with asymmetric keys (post-2025); validate using `supabase.auth.getUser()` or local JWT verification |
| **No service_role access** | All tools run as the authenticated user; no tool bypasses RLS |
| **Bearer token in Authorization header** | Standard MCP auth pattern; supported by all MCP clients |
| **OAuth 2.1 with PKCE** | For desktop clients (Claude Desktop, Cursor); Supabase recently added formal MCP OAuth support |
| **Token refresh** | Supabase auto-refresh; MCP clients handle token lifecycle |

### Security Boundaries

- **No tool exposes the Gemini API key** — admin settings stay server-side
- **All DB queries go through Supabase** — RLS policies are the data access boundary
- **Mutation tools require `destructiveHint: true`** — MCP clients will prompt user for confirmation
- **Rate limiting** — prevent runaway agent loops (implement per-user quota)
- **Input validation** — Zod schemas on all tool inputs prevent injection
- **Output sanitization** — no raw SQL errors; wrap errors in clean MCP error format

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Phase |
|---------|------------|---------------------|----------|-------|
| Auth middleware | Critical | MEDIUM | P1 | Phase 1 |
| `list_cars` tool | Critical | LOW | P1 | Phase 1 |
| `get_car` tool | Critical | LOW | P1 | Phase 1 |
| `list_sessions` tool | Critical | MEDIUM | P1 | Phase 1 |
| `get_session` tool | Critical | LOW | P1 | Phase 1 |
| `get_session_flags` tool | Critical | LOW | P1 | Phase 1 |
| `get_dtc_info` tool | Critical | LOW | P1 | Phase 1 |
| `list_maintenance` tool | High | LOW | P1 | Phase 1 |
| Error handling | Critical | LOW | P1 | Phase 1 |
| Tool annotations | Medium | LOW | P1 | Phase 1 |
| `compute_trends` tool | High | MEDIUM | P2 | Phase 2 |
| `get_dashboard_stats` tool | High | MEDIUM | P2 | Phase 2 |
| `get_car_health_summary` tool | High | HIGH | P2 | Phase 2 |
| `search_sessions` tool | Medium | HIGH | P2 | Phase 2 |
| `get_session_rows_preview` tool | Medium | HIGH | P2 | Phase 2 |
| `analyze_session` tool | High | HIGH | P2 | Phase 2 |
| `chat_with_context` tool | High | HIGH | P2 | Phase 2 |
| Prompts (`/diagnose-session`, etc.) | Medium | MEDIUM | P2 | Phase 2 |
| `create_maintenance_event` tool | Medium | LOW | P3 | Phase 3 |
| `toggle_flag_resolved` tool | Low | LOW | P3 | Phase 3 |
| `compare_sessions` tool | Medium | HIGH | P3 | Phase 3 |
| Resources (URIs) | Low | MEDIUM | P3 | Phase 3 |
| Rate limiting | Medium | MEDIUM | P3 | Phase 3 |
| Audit logging | Medium | LOW | P3 | Phase 3 |

**Priority key:**
- P1: Must have for launch — server is unusable without these
- P2: Core value proposition — differentiators that justify the MCP server
- P3: Nice to have — power user features, add when Phase 1+2 are stable

## Competitor/Reference Analysis

| Pattern | Supabase MCP (Official) | Generic DB MCP Server | Our Approach (Car Insights AI) |
|---------|------------------------|-----------------------|-------------------------------|
| **Tool granularity** | Maps DB tables to tools (PostgREST-style) | Raw SQL query tool | Domain-specific tools (not 1:1 with tables) |
| **Auth** | OAuth 2.1 + PAT | JWT or none | Supabase JWT + OAuth 2.1 |
| **Safety** | Read-only mode, feature groups | No built-in safety | Read-only by default; mutations are opt-in with annotations |
| **Domain logic** | None (generic DB access) | None | Trend computation, DTC lookup, health aggregation, Gemini AI |
| **Resources** | Some | None | Structured `car://`, `dtc://` URIs |
| **Prompts** | None | None | `/diagnose-session`, `/car-health`, etc. |
| **Prompt injection defense** | Feature groups, project scoping | None | Bounded tools (no raw SQL); input validation via Zod |

## Sources

- **MCP TypeScript SDK v2 docs:** https://github.com/modelcontextprotocol/typescript-sdk (commits: 327243ce)
- **MCP specification (2025-11-25):** https://modelcontextprotocol.io/specification/2025-11-25
- **Supabase MCP Authentication docs:** https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication (2026-05-22)
- **Supabase Defense in Depth for MCP:** https://supabase.com/blog/defense-in-depth-mcp (2025-09-16)
- **MCP Handbook (typollak2):** https://github.com/ypollak2/mcp-handbook — architecture patterns, security, auth
- **MCP Server Best Practices (MCPcat):** https://mcpcat.io/blog/mcp-server-best-practices/ — tool organization, namespacing
- **Awesome MCP Best Practices:** https://github.com/lirantal/awesome-mcp-best-practices/ — tool naming, descriptions
- **MCP Resources, Tools, Prompts guide:** https://aiagentskit.com/blog/mcp-resources-tools-prompts/ — primitive usage patterns
- **Car Insights AI codebase:** `src/lib/db.ts`, `src/lib/db-extras.ts`, `src/lib/dtc-codes.ts`, `src/lib/insight-engine.ts`, `src/lib/trends.ts`, `src/lib/chat/db.ts`, `src/lib/ai-client.ts`
- **SEED-001:** `.planning/seeds/SEED-001-mcp-server.md` — initial tool surface ideation
- **INTEGRATIONS.md:** `.planning/codebase/INTEGRATIONS.md` — full schema and auth audit

---

*Feature research for: Car Insights AI MCP Server*
*Researched: 2026-05-22*
