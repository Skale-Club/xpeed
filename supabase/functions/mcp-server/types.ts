// Type-only contract for archived tools; the retired endpoint stays 410 Gone.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}
