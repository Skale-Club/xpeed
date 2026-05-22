---
id: SEED-001
status: dormant
planted: 2026-05-22
planted_during: Active Development
trigger_when: next milestone
scope: medium
---

# SEED-001: MCP Server para Car Insights AI

## Why This Matters

Expor dados e funcionalidades do Car Insights AI via protocolo MCP (Model Context Protocol) para que agentes/LLMs possam interagir diretamente com o sistema — consultar perfis de carros, sessions, DTCs, manutenção, análises e gerar insights.

## When to Surface

**Trigger:** next milestone

This seed should be presented during `/gsd-new-milestone` when the milestone
scope matches any of these conditions:
- Expansão do ecossistema / integrações externas
- Expor API para agentes/LLMs consumirem
- Próximo milestone após as fases de critical fixes e performance

## Scope Estimate

**Medium** — uma ou duas fases: planejamento + implementação do MCP server como um serviço Node.js separado ou edge function.

## Breadcrumbs

Related code and decisions found in the current codebase:

- `src/lib/db.ts` — Core database operations (sessions, car profiles, flags, rows)
- `src/lib/db-extras.ts` — Maintenance log, photos, shared reports, dashboard stats
- `src/lib/insight-engine.ts` — Insight/flag detection engine with rules
- `src/lib/ai-client.ts` — Gemini AI client wrapper (edge function invocation)
- `src/lib/chat/types.ts` — Chat types (Message, Conversation, ChatContext)
- `src/lib/chat/db.ts` — Chat database operations (conversations, messages)
- `src/lib/dtc-codes.ts` — DTC lookup (120+ standard OBD-II codes)
- `src/lib/default-rules.ts` — Default diagnostic rules per vehicle model
- `src/lib/trends.ts` — Per-parameter trend computation across sessions
- `src/lib/csv-parser.ts` — OBD2 CSV parsing logic
- `src/lib/canonical-params.ts` — Canonical parameter mapping
- `src/lib/vin-decoder.ts` — VIN decoding utility
- `src/types/session.ts` — Session domain types (Session, SessionFlag, SessionRow)
- `src/integrations/supabase/client.ts` — Supabase client config
- `src/contexts/AuthContext.tsx` — Auth state management
- `src/contexts/CarsContext.tsx` — Car profiles state management
- `supabase/functions/chat/index.ts` — Edge function: Gemini chat with vehicle context
- `supabase/functions/analyze-session/index.ts` — Edge function: Gemini session analysis
- `supabase/functions/_shared/quota.ts` — Per-user daily quota enforcement
- `supabase/functions/_shared/admin-config.ts` — Admin config (Gemini key, model)
- `supabase/migrations/` — Full DB schema (sessions, flags, maintenance, etc.)
- `supabase/setup_db.sql` — Database setup with RLS policies
- `.planning/codebase/ARCHITECTURE.md` — Architecture overview
- `.planning/codebase/STACK.md` — Tech stack details
- `.planning/codebase/INTEGRATIONS.md` — Integration points

## MCP Server Surface (Potential)

Tools que o MCP server poderia expor:

| Tool | Description |
|------|-------------|
| `list_cars` | Listar perfis de carros do usuário |
| `get_car` | Detalhes de um carro específico |
| `list_sessions` | Listar sessions OBD2 de um carro |
| `get_session` | Detalhes de uma session específica |
| `get_session_flags` | Flags/diagnósticos de uma session |
| `get_session_rows` | Dados brutos OBD2 de uma session |
| `get_dtc_info` | Lookup de código DTC |
| `list_maintenance` | Histórico de manutenção |
| `compute_trends` | Tendências por parâmetro |
| `analyze_session` | Análise via Gemini de uma session |
| `chat_with_context` | Chat com contexto veicular completo |
| `get_dashboard_stats` | Estatísticas do dashboard |

## Notes

- MCP server pode ser implementado como um serviço Node.js standalone ou como uma edge function separada
- Precisa autenticar via Supabase JWT (reaproveitar auth existente)
- Ideal para integrar o Car Insights AI com assistentes tipo Claude Desktop, Cursor, OpenCode, etc.
