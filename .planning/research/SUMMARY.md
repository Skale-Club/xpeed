# Research Summary: MCP Server for Car Insights AI

**Project:** Car Insights AI — MCP Server Integration
**Domain:** MCP (Model Context Protocol) server — car diagnostics data exposed to LLM agents
**Researched:** 2026-05-22
**Confidence:** HIGH (research sources verified against official SDK docs, Supabase MCP guides, and production post-mortems)

## Executive Summary

The Car Insights AI MCP server exposes vehicle diagnostics data (car profiles, OBD2 sessions, DTC codes, maintenance history, AI analysis) to LLM agents via Anthropic's Model Context Protocol. Experts build this as a bounded tool surface over an existing Supabase backend — an **Aggregator Pattern** server that combines DB queries, domain logic (trend computation, DTC lookup), and AI services behind cohesive tools. The recommended approach is to implement the MCP server as a **Supabase Edge Function (Deno)** using the `@modelcontextprotocol/sdk` v1.29 with Streamable HTTP transport and custom JWT auth, minimizing infrastructure delta from the existing project.

The single most important design decision — and the main tension across research — is the **deployment model**: STACK research (verified against official Supabase MCP docs) conclusively supports a Deno Edge Function using `WebStandardStreamableHTTPServerTransport`, while ARCHITECTURE research pushes for a standalone Node.js Express server. **The Edge Function approach is recommended for MVP** because it requires zero new infrastructure, follows the project's existing Edge Function pattern, and the SDK's `WebStandardStreamableHTTPServerTransport` resolves the SSE/state concerns that motivated the standalone recommendation. The standalone architecture remains a viable migration path for Phase 5 if SSE streaming or cold start latency becomes a production issue.

**Top risks:** (1) **Service role key RLS bypass** — the most common and dangerous MCP pitfall (documented data loss incidents); mitigated by using per-user JWT clients for all user-scoped queries. (2) **Prompt injection through CSV/OBD2 data** — user-uploaded CSVs can carry adversarial payloads; mitigated by output sanitization middleware. (3) **Cold start latency on Edge Functions** — solvable via bundling and keep-warm cron (no cold starts >200ms with bundling). (4) **JWT verification incompatibility** — Supabase's RS256 asymmetric keys fail with gateway-level `verify_jwt`; mitigated by deploying with `--no-verify-jwt` and validating tokens in code.

---

## Key Findings

### Recommended Stack

The stack is well-understood and HIGH confidence. Core technologies:

| Technology | Version | Purpose | Why Recommended |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP server core — tools, resources, transport | Official SDK from Anthropic/Linux Foundation. 15M+ weekly npm downloads. Zod-native API. |
| Hono | ^4.9.7 | HTTP framework for Streamable HTTP transport | Edge-native. Supabase's own MCP deployment guide uses Hono. TypeScript-first. |
| Zod | ^3.25.x (existing) | Schema validation for tool parameters | Existing project dependency. MCP SDK maintains backwards compat with v3. |
| Deno (Supabase Edge Runtime) | 2.x (managed by Supabase) | Runtime environment | Existing project infrastructure. Same pattern as `chat` and `analyze-session` Edge Functions. |
| Jose | ^6.2.3 | Local JWT verification (JWKS) | 0-dependency JWT validation. Sub-millisecond, no network hop. |
| MCP Inspector | latest (npx) | Development debugging | Interactive tool/resource testing without a real MCP client. |

**Deployment model:** Edge Function with `--no-verify-jwt` and in-code JWT validation. The existing `supabase functions serve` + `supabase functions deploy` workflow applies unchanged.

**Key stack decisions:**
- **Transport:** `WebStandardStreamableHTTPServerTransport` (NOT SSE — SSE is deprecated by the 2025-11-25 spec)
- **Auth:** Supabase JWT bearer token for v1.1; OAuth 2.1 deferred to v1.2+
- **SDK version:** v1.29 stable (NOT v2 alpha — incomplete, breaking API changes)
- **Runtime:** npm: specifiers in Deno Edge Runtime (NOT npm install — the project's existing pattern)

### Expected Features

**Phase 1 — Core Read-Only (MVP):** Auth middleware, `list_cars`, `get_car`, `list_sessions`, `get_session`, `get_session_flags`, `get_dtc_info`, `list_maintenance`, error handling, tool annotations. These are **table stakes** — without them the MCP server is unusable.

**Phase 2 — Analysis & Trends (Differentiators):** `compute_trends`, `get_dashboard_stats`, `get_car_health_summary` (aggregator tool combining 5+ data sources), `search_sessions`, `get_session_rows_preview`, `analyze_session` (Gemini AI), `chat_with_context`, prompts (`/diagnose-session`, `/car-health`). The aggregator tools reduce 4-5 sequential LLM calls to one.

**Phase 3 — Guided Workflows & Mutations (Power User):** `create_maintenance_event` (destructiveHint), `toggle_flag_resolved`, `compare_sessions`, full resource URI scheme (`car://`, `dtc://`), rate limiting, audit logging.

**Anti-features (explicitly NOT exposed):** `delete_session`, `create_car_profile`, `upload_csv`, raw SQL/`query_database`, admin settings. These create prompt injection, data loss, or architectural problems.

### Architecture Approach

**Primary architecture: Edge Function (Deno) with per-request auth, Streamable HTTP transport, and modular tool/service separation.** The code structure follows the ARCHITECTURE.md design but deployed as an Edge Function rather than a standalone Node.js process.

**Major components:**
1. **Auth Middleware** — Validates Supabase JWT via `jose` + cached JWKS; extracts `user_id` from `sub` claim; attaches `authInfo` to request context
2. **MCP Transport** — `WebStandardStreamableHTTPServerTransport` handling POST (tool calls), optional GET (SSE stream), DELETE (teardown)
3. **Tool Layer** — One file per domain (`cars.ts`, `sessions.ts`, `dtc.ts`, `trends.ts`, `maintenance.ts`, `dashboard.ts`, `ai.ts`); each exports a handler with Zod schema
4. **Service Layer** — Thin wrappers around Supabase queries (replicated from `src/lib/`), domain logic copies (`trends.ts`, `dtc-codes.ts`)
5. **Observability** — Structured logging; per-tool rate limiting; usage tracking via `mcp_usage` table

**Auth flow:** Bearer token from `Authorization` header → local JWT verification via `jose` (jwtVerify + JWKS) → `user_id` extracted → user-scoped Supabase client created (anon key + user JWT) → RLS enforces row-level isolation.

**Key architectural decision:** Do NOT create a shared package between MCP server and React SPA. Replicate thin data access functions (2-5 lines each) in `mcp-server/src/services/`. Extract to a shared package only if duplication becomes painful (2+ changes to same logic).

### Critical Pitfalls

1. **Service Role Key Bypassing RLS** — Using `service_role` for user-scoped queries bypasses all RLS. One prompt injection = full database exfiltration (documented real-world incidents). **Prevention:** Never use `service_role` for user queries. Create per-request supabase client with user's JWT. Reserve `service_role` for admin ops (quota checks, config reads).

2. **Supabase `verify_jwt` Incompatibility with RS256** — Projects created after May 2025 use asymmetric RS256 keys. The Edge Function gateway's built-in `verify_jwt` doesn't support these — returns misleading 401s. **Prevention:** Always deploy with `--no-verify-jwt`; validate tokens in handler code using `jose` + JWKS.

3. **Prompt Injection Through Tool Results** — CSV files, session notes, or DTC descriptions can carry adversarial instructions. The LLM can't distinguish data from commands. **Prevention:** Sanitize all user-generated content before returning; use structured JSON output (not raw narrative); add injection detection middleware.

4. **Unbounded Result Sizes Eating Context Window** — The existing `getSessionRows()` returns 1000 rows by default (50-100KB JSON). An agent calling this burns the entire context window. **Prevention:** Cursor-based pagination on every multi-result tool; sensible default limits (20 for lists, 50 for detail); return `total` + `returned` metadata.

5. **Tool Descriptions That Cause Wrong-Tool Selection** — Vague descriptions like "Get session details" cause 40-60% more misrouted calls. **Prevention:** Three-part descriptions: [what it does] + [output format] + [when NOT to use / disambiguation]. Test descriptions against the question "would an LLM choose the right tool?"

---

## Implications for Roadmap

Based on integrated research across all four documents, the recommended phase structure:

### Phase 1: Foundation & Core Read Tools (MVP Launch)
**Rationale:** Auth, transport, and the basic tool surface are the critical path — everything depends on these. Delivering read-only car data to LLMs provides immediate value and validates the MCP integration pattern.
**Stack:** Edge Function scaffold with `@modelcontextprotocol/sdk` ^1.29, Hono, Zod v3, `jose` for JWT
**Delivers:** Working MCP server where LLMs can answer "what's wrong with my car?" by reading flags, DTCs, and maintenance history
**Addresses (FEATURES.md):** Auth middleware, `list_cars`, `get_car`, `list_sessions`, `get_session`, `get_session_flags`, `get_dtc_info`, `list_maintenance`, error handling, tool annotations
**Avoids (PITFALLS.md):**
- Pitfall 1 (service_role bypass) — Establish per-user JWT client pattern from day one
- Pitfall 2 (verify_jwt RS256) — Deploy with `--no-verify-jwt`, in-code validation
- Pitfall 4 (SSE lock-in) — Use `WebStandardStreamableHTTPServerTransport` not SSE
- Pitfall 8 (cold starts) — Bundle the Edge Function; add keep-warm cron
**Architecture components:** `auth/middleware.ts`, `auth/jwks.ts`, `transport.ts`, `server/mcp-server.ts`, `services/{cars,sessions,dtc}.ts`, `tools/{cars,sessions,dtc}.ts`
**Research flag:** **Standard patterns** — Auth and transport are well-documented by official MCP SDK + Supabase docs. No additional research needed.

### Phase 2: Analysis & Trends
**Rationale:** Requires Phase 1's data layer to be working (trends need sessions, dashboard needs data, health summary needs everything). These are the differentiators that justify building the MCP server over a generic Supabase MCP.
**Stack:** Reuses `computeTrends()` domain logic from `src/lib/trends.ts`; `get_dashboard_stats` RPC already exists
**Delivers:** LLMs can compute trends ("is X getting worse?"), get dashboard-style health overviews, search sessions, inspect raw OBD2 data, and get one-shot comprehensive health reports
**Addresses (FEATURES.md):** `compute_trends`, `get_dashboard_stats`, `get_car_health_summary`, `search_sessions`, `get_session_rows_preview`
**Avoids (PITFALLS.md):**
- Pitfall 3 (prompt injection) — Implement output sanitization middleware before AI-integrated tools
- Pitfall 5 (schema breakage) — Design all tool schemas for cross-client compatibility
- Pitfall 6 (descriptions) — Review all tool descriptions with three-part format
- Pitfall 7 (unbounded results) — Pagination on `search_sessions` and `get_session_rows_preview`
- Pitfall 9 (tools vs resources) — Classify each feature as tool or resource with documented rationale
**Research flag:** **Research recommended** — Cross-client tool schema compatibility testing. Need to verify schemas work in Claude Desktop, Cursor, and OpenCode during planning. Allocate time for multi-client testing.

### Phase 3: AI Integration & Settings UI
**Rationale:** `analyze_session` and `chat_with_context` depend on deployed Edge Functions (existing `analyze-session` and `chat`) PLUS an admin-configured Gemini API key. The Settings page MCP section needs the React frontend. These are independent concerns that converge in this phase.
**Stack:** `services/gemini.ts` for server-side Gemini API calls; React frontend for Settings page; existing Edge Functions unchanged
**Delivers:** LLMs can trigger AI analysis, chat with vehicle context, and users can generate/manage MCP tokens from the Settings page
**Addresses (FEATURES.md):** `analyze_session`, `chat_with_context`, prompts (`/diagnose-session`, `/car-health`)
**Avoids (PITFALLS.md):**
- Pitfall 9 (resources vs tools) — `analyze_session` is clearly a tool (side-effect: Gemini API call), not a resource
- Pitfall 7 (unbounded results) — AI analysis responses are bounded by design (structured findings, not raw data)
**Research flag:** **Standard patterns** — Settings page MCP section is a standard UI pattern. Token generation reuses existing Supabase auth. No additional domain research needed.

### Phase 4: Mutations, Resources & Production Hardening
**Rationale:** Mutations must come after the read-only layer is stable and battle-tested. Resource URIs are a nice-to-have overlay on tools. Production hardening (rate limiting, audit logging, usage tracking) should be informed by observed usage from Phases 1-3.
**Stack:** `mcp_usage` DB migration; pino for structured logging; per-tool rate limit configuration
**Delivers:** LLM can log maintenance, resolve flags, compare sessions side-by-side. Structured resource URIs (`car://`, `dtc://`). Rate-limited, auditable production MCP server.
**Addresses (FEATURES.md):** `create_maintenance_event`, `toggle_flag_resolved`, `compare_sessions`, resource URIs, all prompts, rate limiting, audit logging
**Avoids (PITFALLS.md):**
- Pitfall 1 (service_role bypass) — Mutation tools use user-JWT-scoped client; mutations go through RLS
- Pitfall 7 (unbounded results) — Full pagination review before Phase 4
- Anti-features — `delete_session`, `create_car_profile`, `upload_csv` remain explicitly NOT exposed
**Research flag:** **Research recommended** — Resource URI namespace design. Need to determine URI patterns before implementation. Also: OAuth 2.1 migration planning for v1.2 (bearer token is fine for v1.1 but OAuth will be needed for desktop client UX).

### Phase Ordering Rationale

- **Auth first (Phase 1)** — Every tool depends on user identity. No tool can be built before auth is established. The per-user JWT client pattern must be in place from day one to avoid the `service_role` shortcut trap.
- **Read tools before analysis (Phase 1 → 2)** — Trends need sessions, dashboard stats need session data, health summaries need everything. The dependency graph from FEATURES.md makes this ordering explicit.
- **Analysis before AI (Phase 2 → 3)** — `analyze_session` and `chat_with_context` need working data retrieval first. These also cross a trust boundary (Gemini API key exposure risk) — the output sanitization from Phase 2 is a prerequisite.
- **Mutations last (Phase 4)** — Mutations introduce destructive risk. Building on a stable, well-tested, rate-limited read-only server means the mutation layer is safer by design.
- **Hardening along the way** — Basic logging starts in Phase 1. Rate limits are configured in Phase 2. Full audit logging and usage tracking arrive in Phase 4. This avoids premature optimization while ensuring production-readiness when needed.

### Research Flags

Phases needing deeper research during planning:
- **Phase 2:** Cross-client tool schema compatibility — need to validate Zod-generated JSON Schema against real MCP clients (Claude Desktop, Cursor, OpenCode, VS Code). Budget for a testing day.
- **Phase 4:** Resource URI namespace design — need to define the URI scheme (`car://`, `dtc://`, etc.) and resource template patterns before implementation. Also: OAuth 2.1 migration path for v1.2.

Phases with well-documented patterns (skip research-phase):
- **Phase 1:** Auth + transport are comprehensively documented by official MCP SDK and Supabase MCP deployment guide
- **Phase 3:** Settings UI for MCP tokens is a standard CRUD + clipboard pattern. No novel research needed.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against official MCP SDK docs (npm, GitHub), Supabase MCP deployment guide, and npm registry. Version numbers confirmed. |
| Features | HIGH | Thorough analysis of the Car Insights domain, existing codebase (15+ source files examined), seed document, and community best practices. Feature dependency graph is logical and consistent. |
| Architecture | MEDIUM | **Disagreement between STACK.md (Edge Function) and ARCHITECTURE.md (Standalone Node.js).** The Edge Function approach is recommended for MVP based on newer SDK capabilities (`WebStandardStreamableHTTPServerTransport`), existing project alignment, and the ARCHITECTURE.md concerns being addressable. The standalone approach remains a valid Phase 5 migration path. Code structure, auth patterns, and anti-pattern guidance from ARCHITECTURE.md are adopted regardless. |
| Pitfalls | HIGH | 19+ production sources including official docs, post-mortems, production surveys (38.7% zero-auth servers in the wild), and documented MCP incidents. Mitigation strategies are concrete and verifiable. |

**Overall confidence:** HIGH — all four research areas have strong source quality. The STACK vs ARCHITECTURE tension has a clear resolution path (Edge Function MVP → standalone if needed). No unresolvable unknowns.

### Gaps to Address

1. **Deployment model final decision** — STACK (Edge Function) and ARCHITECTURE (Standalone Node.js) disagree. Recommended resolution: Edge Function for MVP with documented criteria for when to migrate. This needs explicit sign-off during requirements phase.

2. **JWT token lifecycle for MCP clients** — Supabase JWTs expire in 1 hour. MCP clients (Claude Desktop, Cursor) expect persistent tokens. Three options exist (auto-refresh, longer-lived token via auth hook, API key pattern). Needs UX and security review.

3. **SSE notification requirements** — Edge Functions can't maintain SSE streams. If the product needs server-to-client notifications (e.g., "analysis complete" events), this is a constraint. Confirm MVP doesn't need SSE notifications.

4. **Performance baseline** — Cold start latency for bundled Edge Function vs standalone Node.js. Need to measure actual cold start times on Supabase production to validate the recommendation. Benchmarks from research indicate 80-150ms bundled, but this should be verified.

---

## Sources

### Primary (HIGH confidence)
- **MCP TypeScript SDK v1.29 docs** (npm: `@modelcontextprotocol/sdk`) — SDK architecture, transports, tool registration, auth patterns — official
- **MCP Specification 2025-11-25** (spec.modelcontextprotocol.io) — Streamable HTTP, OAuth 2.1, tool annotations — official spec
- **Supabase Docs: Deploy MCP servers** — Hono + Streamable HTTP deployment guide — official Supabase
- **Supabase Docs: MCP Authentication** — OAuth 2.1 flow with Supabase Auth — official Supabase
- **Supabase Docs: Securing Edge Functions** — `withSupabase` auth modes, RS256 compatibility — official Supabase
- **Supabase Blog: MCP Server announcement** — Confirms Supabase's MCP investment — official

### Secondary (MEDIUM confidence)
- **General Analysis (2026-04-10)** — Supabase MCP service_role attack demonstration — detailed, credible
- **Fordel Studios (2026-03-20)** — Production MCP server patterns — JWKS caching, session management, Streamable HTTP
- **Apigene Blog (2026-03-26)** — Tool descriptions reduce misrouted calls 40-60% — actionable data
- **Mohammad Khan (2026-03-01)** — Production MCP patterns — `isError: true`, output sanitization, tool annotations
- **Jawuil Pineda (2026-05-17)** — "Why You Shouldn't Use Supabase's Official MCP" — first-hand service_role data loss account
- **Vitaly Sem (2026-05-18)** — 7 MCP mistakes — tool annotations, outcome-oriented tools, safe defaults
- **Shareuhack (2026-04-18)** — Production deployment survey — 38.7% zero-auth servers, session/load balancer conflicts
- **Dev.to: Building Production MCP Servers** — Connection pooling, auth, rate limiting
- **LogRocket (2026-05-05)** — Building MCP Server with Node.js — practical patterns
- **matt-fournier/supabase-mcp-template** — Edge Function MCP pattern with `--no-verify-jwt`
- **iceener/streamable-mcp-server-template** — Production auth, session management patterns

### Tertiary (LOW confidence — single source)
- **Supabase CLI Issue #5076** — Undocumented ~4MB Edge Function bundle size limit. Needs verification.

---

*Research completed: 2026-05-22*
*Ready for roadmap: yes*
