# Roadmap: Car Insights AI

## Overview

This roadmap covers the Car Insights AI project — a React + Supabase SPA for OBD2 diagnostics with Gemini AI. Milestone v1.0 (phases 01-06) delivers the core diagnostics platform. Milestone v1.1 (phases 07-10) adds an MCP (Model Context Protocol) server exposing vehicle diagnostics data to LLM agents, with auth token management in the Settings UI.

## Milestones

- 🚧 **v1.0 MVP** — Phases 01-06 (core platform in progress)
- 🚧 **v1.1 MCP Server** — Phases 07-10 (this milestone)

## Phases

- [ ] **Phase 07: Foundation & Core Read-Only Tools** — Auth, transport, and basic read tools (cars, sessions, DTCs, maintenance)
- [ ] **Phase 08: Analysis & Trends** — Trend computation, dashboard stats, health summaries, session search, output sanitization
- [ ] **Phase 09: AI Integration & Settings UI** — Gemini analysis, chat with context, MCP prompts, token management UI
- [ ] **Phase 10: Mutations, Resources & Hardening** — Write tools, resource URIs, rate limiting, audit logging, anti-features

---

## Phase Details

### Phase 07: Foundation & Core Read-Only Tools
**Goal**: A working MCP server deployed as a Supabase Edge Function that exposes basic read-only vehicle data to LLM agents via authenticated, paginated tools
**Depends on**: Nothing (first v1.1 phase)
**Requirements**: MCP-01, MCP-02, MCP-03, MCP-04, MCP-05, MCP-06, MCP-07, MCP-08, MCP-09, MCP-10, MCP-11, MCP-12
**Success Criteria** (what must be TRUE):
  1. MCP server deploys as a Supabase Edge Function responding to Streamable HTTP POST requests at the configured endpoint
  2. Auth middleware validates Supabase JWT bearer tokens via `jose` + JWKS — unauthorized requests receive standardized error responses
  3. Tools `list_cars`, `get_car`, `list_sessions`, `get_session`, `get_session_flags`, `get_dtc_info`, and `list_maintenance` return accurate, user-scoped data from the authenticated user
  4. All multi-result tools support cursor-based pagination with metadata (`total`, `returned`, `next_cursor`)
  5. All tools have proper annotations (`readOnly`, `destructiveHint`, `idempotent`) and return `isError: true` responses for invalid inputs, missing data, or auth failures
**Plans**: TBD

### Phase 08: Analysis & Trends
**Goal**: LLMs can compute trends, generate dashboard statistics, get comprehensive car health summaries, search sessions, and inspect raw OBD2 data — with output sanitization and clear three-part tool descriptions
**Depends on**: Phase 07
**Requirements**: MCP-13, MCP-14, MCP-15, MCP-16, MCP-17, MCP-18, MCP-19
**Success Criteria** (what must be TRUE):
  1. `get_car_health_summary` aggregates health score, flags, DTCs, trends, and maintenance in a single tool call — reducing 5+ sequential LLM calls to one
  2. `compute_trends` returns per-parameter trend analysis across OBD2 sessions with direction and severity
  3. `get_dashboard_stats` returns aggregate dashboard metrics (recent flags, health trends, latest session summary)
  4. `search_sessions` enables full-text search across sessions with filters (date range, parameter names) and paginated results
  5. Output sanitization middleware strips user-generated content that could carry prompt injection payloads before returning tool responses
**Plans**: TBD

### Phase 09: AI Integration & Settings UI
**Goal**: LLMs can perform AI-powered session analysis and chat with full vehicle context; users can generate, copy, and revoke MCP tokens from the Settings page
**Depends on**: Phase 08 (needs output sanitization from Phase 08 before crossing AI trust boundary)
**Requirements**: MCP-20, MCP-21, MCP-22, MCP-23, MCP-24, MCP-25
**Success Criteria** (what must be TRUE):
  1. `analyze_session` invokes Gemini AI and returns a structured analysis (key findings, severity, recommendations) for a given OBD2 session
  2. `chat_with_context` enables LLM conversation with full vehicle context — user can ask questions about their car and get answers informed by session, flag, DTC, and maintenance data
  3. MCP prompts (`/diagnose-session`, `/car-health`) provide usage guidance to LLMs for common diagnostic workflows
  4. Settings page shows an MCP section where users can generate a 30-day token, copy it to clipboard, and revoke it — the token is stored in `app_settings` with extended validity
  5. Every tool call is logged to `mcp_usage` table with user_id, tool name, timestamp, and success/failure status
**Plans**: TBD
**UI hint**: yes

### Phase 10: Mutations, Resources & Hardening
**Goal**: LLMs can create maintenance events, toggle flag resolution, and compare sessions side-by-side via structured resources — all within a rate-limited, auditable, production-hardened MCP server with documented anti-features
**Depends on**: Phase 08, Phase 09
**Requirements**: MCP-26, MCP-27, MCP-28, MCP-29, MCP-30, MCP-31, MCP-32
**Success Criteria** (what must be TRUE):
  1. `create_maintenance_event` creates a maintenance event with `destructiveHint: true` annotation, enforcing user ownership via RLS
  2. `toggle_flag_resolved` marks/unmarks a session flag as resolved, with proper validation and ownership checks
  3. `compare_sessions` returns side-by-side comparison of two sessions including parameter differences and flag overlap
  4. Resource URI templates (`car://{id}`, `dtc://{code}`, `session://{id}`) resolve to structured data via the MCP resources protocol
  5. Anti-features are documented: `delete_session`, `create_car_profile`, `upload_csv`, and `query_database` are explicitly NOT exposed, with rationale in the codebase
**Plans**: TBD

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 01. Keepalive Hardening | v1.0 | — | Complete | 2026-05-15 |
| 02. Car Onboarding Wizard | v1.0 | — | Not started | - |
| 03. Critical Security & Bug Fixes | v1.0 | — | Not started | - |
| 04. Performance Optimization | v1.0 | — | Not started | - |
| 05. UI/UX & Dashboard Enhancement | v1.0 | — | Not started | - |
| 06. Test Coverage & Quality | v1.0 | — | Not started | - |
| 07. Foundation & Core Read-Only Tools | v1.1 | 0/TBD | Not started | - |
| 08. Analysis & Trends | v1.1 | 0/TBD | Not started | - |
| 09. AI Integration & Settings UI | v1.1 | 0/TBD | Not started | - |
| 10. Mutations, Resources & Hardening | v1.1 | 0/TBD | Not started | - |
