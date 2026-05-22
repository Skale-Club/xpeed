# Phase 07: Foundation & Core Read-Only Tools

**Goal:** A working MCP server deployed as a Supabase Edge Function that exposes basic read-only vehicle data to LLM agents via authenticated tools.

**Requirements:** MCP-01 through MCP-12

## Files Created

### MCP Server (Edge Function)
| File | Purpose |
|------|---------|
| `supabase/functions/mcp-server/index.ts` | Main entry — Hono HTTP server with JSON-RPC MCP handler, auth middleware, tool dispatch |
| `supabase/functions/mcp-server/auth.ts` | JWT validation via `supabase.auth.getUser()` + `createUserClient()` factory |
| `supabase/functions/mcp-server/services/cars.ts` | Car profile queries (list/get) |
| `supabase/functions/mcp-server/services/sessions.ts` | Session queries with cursor-based pagination |
| `supabase/functions/mcp-server/services/dtc.ts` | DTC code lookup (~20 curated codes) with search |
| `supabase/functions/mcp-server/services/maintenance.ts` | Maintenance event queries |
| `supabase/functions/mcp-server/services/supabase.ts` | Admin client factory + JSONB helper |
| `supabase/functions/mcp-server/tools/cars.ts` | Tool definitions: `list_cars`, `get_car` |
| `supabase/functions/mcp-server/tools/sessions.ts` | Tool definitions: `list_sessions`, `get_session`, `get_session_flags`, `get_session_rows` |
| `supabase/functions/mcp-server/tools/dtc.ts` | Tool definitions: `get_dtc_info`, `search_dtcs` |
| `supabase/functions/mcp-server/tools/maintenance.ts` | Tool definition: `list_maintenance` |

## Tools Available (9 total)

| Tool | Description | Annotations |
|------|-------------|-------------|
| `list_cars` | List all car profiles for the authenticated user | readOnly, idempotent |
| `get_car` | Get details of a specific car profile | readOnly, idempotent |
| `list_sessions` | List OBD2 sessions for a car (paginated) | readOnly, idempotent |
| `get_session` | Get details of a specific session | readOnly, idempotent |
| `get_session_flags` | Get diagnostic flags for a session | readOnly, idempotent |
| `get_session_rows` | Get raw OBD2 time-series data (paginated) | readOnly, idempotent |
| `get_dtc_info` | Look up a DTC code by code (e.g. P0420) | readOnly, idempotent |
| `search_dtcs` | Search DTC database by keyword | readOnly, idempotent |
| `list_maintenance` | List maintenance history for a car | readOnly, idempotent |

## Deployment Note

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

The `--no-verify-jwt` flag is required because Supabase's gateway JWT verification doesn't support RS256 asymmetric keys. Auth is handled in-code via `supabase.auth.getUser()`.

## Next

Phase 08 will add analysis & trends tools (compute_trends, get_car_health_summary, etc.).
