# xpeed — Project

**Created:** 2026-05-17  
**Last Updated:** 2026-05-22  
**Status:** Active Development — Milestone v1.1

## What is this?

A React + Supabase SPA for OBD2 car diagnostics powered by Gemini AI. Users upload CSV exports from their OBD2 scanners, get automatic analysis (flags, trends, health scores), view dashboards, and chat with an AI assistant that has full vehicle context.

**Target users:** Car enthusiasts, home mechanics, and fleet operators who want intelligent insight from raw OBD2 data without needing an expert.

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui
- **Backend:** Supabase (auth, PostgreSQL, RLS, storage)
- **AI:** Google Gemini 2.5 Flash (analysis + chat)
- **Hosting:** Vercel (SPA)

## Current Milestone: v1.1 MCP Server

**Goal:** Build an MCP (Model Context Protocol) server as a Supabase Edge Function that exposes Car Insights AI data (cars, sessions, DTCs, maintenance, trends, chat) as tools/resources for LLMs and AI agents, with per-user auth token management in Settings.

**Target features:**
- MCP server as Edge Function (Deno) with Streamable HTTP transport
- Read-only tools: cars, sessions, flags, DTC lookup, maintenance
- Analysis tools: trends, health summary, dashboard stats, session search
- AI tools: Gemini analysis, chat with vehicle context
- Auth token generation/management in Settings page (30-day long-lived tokens)
- Production hardening: pagination, sanitization, rate limiting, audit logging

## Current State

### Completed
- [x] Phase 01: Supabase Keepalive Hardening (2026-05-15)
  - GitHub Actions workflow with heartbeat commit
  - Daily health check workflow
  - Verification script

### Core Features Working
- User auth (email/password + Google OAuth)
- Multi-car profile management
- CSV upload + OBD2 parsing
- Insight engine (threshold-based flag detection)
- Dashboard (health score, trends, latest trip)
- Session history with detail view
- Gemini AI chat with vehicle context
- Settings (timezone, distance unit, Gemini API key)

### Known Issues (see .planning/codebase/CONCERNS.md)
- Gemini API key stored plaintext in DB (HIGH security)
- N+1 query patterns in Dashboard and History
- TypeScript `any` overuse in 10+ files
- Auth race condition (brief logged-out flash)
- Chat RLS missing user_id auto-trigger
- No meaningful test coverage
- 1000-row silent truncation in session data

## Roadmap

| Phase | Title | Milestone | Priority | Status |
|-------|-------|-----------|----------|--------|
| 01 | Supabase Keepalive Hardening | v1.0 | P0 | ✅ Done |
| 02 | Complete Car Onboarding Wizard | v1.0 | P1 | 📋 Planned |
| 03 | Critical Security & Bug Fixes | v1.0 | P0 | 📋 Planned |
| 04 | Performance Optimization | v1.0 | P1 | 📋 Planned |
| 05 | UI/UX & Dashboard Enhancement | v1.0 | P2 | 📋 Planned |
| 06 | Test Coverage & Quality | v1.0 | P1 | 📋 Planned |
| 07 | Foundation & Core Read-Only Tools | v1.1 | P0 | 🚧 In Progress |
| 08 | Analysis & Trends | v1.1 | P1 | 📋 Planned |
| 09 | AI Integration & Settings UI | v1.1 | P0 | 📋 Planned |
| 10 | Mutations, Resources & Hardening | v1.1 | P2 | 📋 Planned |

## Success Metrics

- New user → first data upload in < 3 minutes (onboarding)
- Zero HIGH-severity security issues
- Dashboard loads in < 1s (no N+1 queries)
- UI scores ≥ 85/100 on visual audit
- Critical paths covered by integration tests

## Architecture

See `.planning/codebase/ARCHITECTURE.md` for full details.

**Key data flow:** CSV upload → OBD2 parse → Supabase storage + DB → Insight engine → Flags + Summary → Dashboard/Chat

## Conventions

See `.planning/codebase/CONVENTIONS.md`.

- TypeScript strict mode (enforce, no `any`)
- Tailwind utility-first
- Supabase RLS on all tables
- React Context for global state
- Custom hooks for business logic
