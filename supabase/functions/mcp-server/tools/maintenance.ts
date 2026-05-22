import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ToolDefinition } from "../index.ts";
import { listMaintenance } from "../services/maintenance.ts";

export const listMaintenanceTool: ToolDefinition = {
  name: "list_maintenance",
  description: "List maintenance history for a specific car profile. Returns events sorted by date (newest first) with type, date, odometer reading, cost, shop, and notes. Use this to see when maintenance was last performed on a vehicle.",
  inputSchema: {
    type: "object",
    properties: {
      car_id: { type: "string", description: "The car profile ID" },
      limit: { type: "number", description: "Maximum number of maintenance events to return (default 20, max 100)", default: 20 },
    },
    required: ["car_id"],
  },
  handler: async (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => {
    const limit = Math.min(Math.max((args.limit as number) ?? 20, 1), 100);
    const events = await listMaintenance(client, args.car_id as string, limit, userId);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  },
};
