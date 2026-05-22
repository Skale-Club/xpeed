# Requirements — Milestone v1.1: MCP Server

## v1 Requirements

### Phase 1: Foundation & Core Read-Only Tools

- [ ] **MCP-01**: MCP server roda como Supabase Edge Function (Deno) com Streamable HTTP transport
- [ ] **MCP-02**: Auth middleware valida Supabase JWT via `jose` + JWKS; deploy com `--no-verify-jwt`
- [ ] **MCP-03**: Tool `list_cars` — lista perfis de carros do usuário autenticado
- [ ] **MCP-04**: Tool `get_car` — detalhes de um carro específico por ID
- [ ] **MCP-05**: Tool `list_sessions` — lista sessions OBD2 de um carro com paginação
- [ ] **MCP-06**: Tool `get_session` — detalhes de uma session específica
- [ ] **MCP-07**: Tool `get_session_flags` — flags/diagnósticos de uma session
- [ ] **MCP-08**: Tool `get_dtc_info` — lookup de código DTC com descrição e severidade
- [ ] **MCP-09**: Tool `list_maintenance` — histórico de manutenção de um carro
- [ ] **MCP-10**: Error handling padronizado com `isError: true` e mensagens descritivas
- [ ] **MCP-11**: Tool annotations (readOnly, destructiveHint, idempotent) em todas as tools
- [ ] **MCP-12**: Cursor-based pagination em todas as tools multi-resultado

### Phase 2: Analysis & Trends

- [ ] **MCP-13**: Tool `compute_trends` — tendências por parâmetro entre sessions
- [ ] **MCP-14**: Tool `get_dashboard_stats` — estatísticas agregadas do dashboard
- [ ] **MCP-15**: Tool `get_car_health_summary` — health score + flags + DTCs + trends + maintenance (aggregator)
- [ ] **MCP-16**: Tool `search_sessions` — busca textual em sessions com filtros
- [ ] **MCP-17**: Tool `get_session_rows_preview` — preview paginado de dados OBD2 brutos
- [ ] **MCP-18**: Output sanitization middleware contra prompt injection
- [ ] **MCP-19**: Tool descriptions em formato três partes (o que faz + formato output + quando NÃO usar)

### Phase 3: AI Integration & Settings UI

- [ ] **MCP-20**: Tool `analyze_session` — análise Gemini de uma session
- [ ] **MCP-21**: Tool `chat_with_context` — chat com contexto veicular completo
- [ ] **MCP-22**: Prompts MCP (`/diagnose-session`, `/car-health`) para guias de uso
- [ ] **MCP-23**: Settings page — seção MCP com token management (gerar, copiar, revogar)
- [ ] **MCP-24**: MCP auth token armazenado em `app_settings` com validade estendida (30 dias)
- [ ] **MCP-25**: Auditoria de uso — registrar chamadas de tools com user_id, tool, timestamp

### Phase 4: Mutations, Resources & Hardening

- [ ] **MCP-26**: Tool `create_maintenance_event` — criar evento de manutenção (destructiveHint: true)
- [ ] **MCP-27**: Tool `toggle_flag_resolved` — marcar/desmarcar flag como resolvida
- [ ] **MCP-28**: Tool `compare_sessions` — comparar duas sessions lado a lado
- [ ] **MCP-29**: Resource URIs (`car://`, `dtc://`, `session://`) com templates
- [ ] **MCP-30**: Rate limiting por tool (configurável)
- [ ] **MCP-31**: Migration `mcp_usage` + `mcp_tokens` tables no Supabase
- [ ] **MCP-32**: Anti-features documentadas (delete_session, create_car_profile, upload_csv, query_database NÃO expostos)

## Future (v1.2+)

- OAuth 2.1 com Supabase Auth para desktop clients
- SSE notifications para polling de análises longas
- Migração para standalone Node.js se Edge Function mostrar limitações
- Testes de compatibilidade cross-client (Claude Desktop, Cursor, OpenCode, VS Code)

## Out of Scope

- Expor admin settings como tool — risco de segurança
- Expor delete_session ou upload_csv — risco de perda de dados
- SQL direto / query_database — risco de injection
- Per-user Gemini API key — mantém admin-configured (padrão existente)

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| MCP-01 | Phase 07 | Pending |
| MCP-02 | Phase 07 | Pending |
| MCP-03 | Phase 07 | Pending |
| MCP-04 | Phase 07 | Pending |
| MCP-05 | Phase 07 | Pending |
| MCP-06 | Phase 07 | Pending |
| MCP-07 | Phase 07 | Pending |
| MCP-08 | Phase 07 | Pending |
| MCP-09 | Phase 07 | Pending |
| MCP-10 | Phase 07 | Pending |
| MCP-11 | Phase 07 | Pending |
| MCP-12 | Phase 07 | Pending |
| MCP-13 | Phase 08 | Pending |
| MCP-14 | Phase 08 | Pending |
| MCP-15 | Phase 08 | Pending |
| MCP-16 | Phase 08 | Pending |
| MCP-17 | Phase 08 | Pending |
| MCP-18 | Phase 08 | Pending |
| MCP-19 | Phase 08 | Pending |
| MCP-20 | Phase 09 | Pending |
| MCP-21 | Phase 09 | Pending |
| MCP-22 | Phase 09 | Pending |
| MCP-23 | Phase 09 | Pending |
| MCP-24 | Phase 09 | Pending |
| MCP-25 | Phase 09 | Pending |
| MCP-26 | Phase 10 | Pending |
| MCP-27 | Phase 10 | Pending |
| MCP-28 | Phase 10 | Pending |
| MCP-29 | Phase 10 | Pending |
| MCP-30 | Phase 10 | Pending |
| MCP-31 | Phase 10 | Pending |
| MCP-32 | Phase 10 | Pending |

---

*Last updated: 2026-05-22*
